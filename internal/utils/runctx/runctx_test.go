package runctx

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestRegisterRun_LIFOOrder verifies that teardowns run in the reverse order
// they were registered — the invariant callers rely on so a loop-detach
// (registered last) runs before the chroot unmount (registered first) it
// sits on top of.
func TestRegisterRun_LIFOOrder(t *testing.T) {
	c := New()
	var order []string
	var mu sync.Mutex
	record := func(label string) CleanupFunc {
		return func(context.Context) error {
			mu.Lock()
			order = append(order, label)
			mu.Unlock()
			return nil
		}
	}

	c.Register("first", record("first"))
	c.Register("second", record("second"))
	c.Register("third", record("third"))

	if got := c.Run(context.Background()); len(got) != 0 {
		t.Fatalf("expected empty residual, got %v", got)
	}
	want := []string{"third", "second", "first"}
	if len(order) != len(want) {
		t.Fatalf("expected %d entries, got %d: %v", len(want), len(order), order)
	}
	for i, w := range want {
		if order[i] != w {
			t.Fatalf("LIFO order mismatch at %d: want %q got %q (full: %v)", i, w, order[i], order)
		}
	}
}

// TestRegisterRun_ResidualCollectsErrors asserts errors from individual
// teardowns are surfaced in the residual list without aborting the chain —
// a failing unmount must not skip the loop detach that follows.
func TestRegisterRun_ResidualCollectsErrors(t *testing.T) {
	c := New()
	var ran []string
	var mu sync.Mutex
	track := func(label string, err error) CleanupFunc {
		return func(context.Context) error {
			mu.Lock()
			ran = append(ran, label)
			mu.Unlock()
			return err
		}
	}

	c.Register("ok-1", track("ok-1", nil))
	c.Register("boom", track("boom", errors.New("mount stuck")))
	c.Register("ok-2", track("ok-2", nil))

	residual := c.Run(context.Background())
	if len(ran) != 3 {
		t.Fatalf("expected all 3 teardowns to run, got %v", ran)
	}
	if len(residual) != 1 {
		t.Fatalf("expected 1 residual entry, got %d: %v", len(residual), residual)
	}
	if !strings.Contains(residual[0], "boom") || !strings.Contains(residual[0], "mount stuck") {
		t.Fatalf("residual entry should include label and error text, got %q", residual[0])
	}
}

// TestRegisterRun_UnregisterDropsEntry verifies the unregister closure removes
// a registration before Run fires — this is how the happy-path defer in
// rawmaker/overlay avoids double-detach on successful builds.
func TestRegisterRun_UnregisterDropsEntry(t *testing.T) {
	c := New()
	ran := map[string]bool{}
	var mu sync.Mutex
	track := func(label string) CleanupFunc {
		return func(context.Context) error {
			mu.Lock()
			ran[label] = true
			mu.Unlock()
			return nil
		}
	}

	c.Register("keep", track("keep"))
	dropIt := c.Register("drop", track("drop"))
	c.Register("also-keep", track("also-keep"))

	dropIt()
	if got := c.Len(); got != 2 {
		t.Fatalf("expected 2 entries after unregister, got %d", got)
	}
	if residual := c.Run(context.Background()); len(residual) != 0 {
		t.Fatalf("expected empty residual, got %v", residual)
	}
	if ran["drop"] {
		t.Fatalf("unregistered entry ran; ran=%v", ran)
	}
	if !ran["keep"] || !ran["also-keep"] {
		t.Fatalf("expected remaining entries to run; ran=%v", ran)
	}
}

// TestRegisterRun_UnregisterAfterRunIsNoop confirms calling the unregister
// closure after Run has fired is safe (no panic, no observable effect).
// This matters because a happy-path defer could race with a cancel-driven
// Run in edge cases.
func TestRegisterRun_UnregisterAfterRunIsNoop(t *testing.T) {
	c := New()
	drop := c.Register("x", func(context.Context) error { return nil })
	c.Run(context.Background())
	drop() // must not panic
	drop() // idempotent under repeated calls
}

// TestRun_PerEntryTimeoutStops verifies a teardown that respects its ctx is
// surfaced as a DeadlineExceeded residual once the per-entry timeout fires,
// and that the next entry in the LIFO chain still runs. The test monkey-
// patches PerEntryTimeout down to a few hundred ms so it completes quickly.
func TestRun_PerEntryTimeoutStops(t *testing.T) {
	original := PerEntryTimeout
	PerEntryTimeout = 200 * time.Millisecond
	defer func() { PerEntryTimeout = original }()

	c := New()
	var slowStarted, fastRan atomic.Bool

	slow := func(ctx context.Context) error {
		slowStarted.Store(true)
		<-ctx.Done()
		return ctx.Err()
	}
	fast := func(context.Context) error {
		fastRan.Store(true)
		return nil
	}

	// LIFO: fast (registered last) runs before slow.
	c.Register("slow", slow)
	c.Register("fast", fast)

	start := time.Now()
	residual := c.Run(context.Background())
	elapsed := time.Since(start)

	if !fastRan.Load() {
		t.Fatalf("expected fast (LIFO first) to run")
	}
	if !slowStarted.Load() {
		t.Fatalf("expected slow (LIFO second) to start")
	}
	if len(residual) != 1 {
		t.Fatalf("expected one residual (slow's ctx.DeadlineExceeded), got %d: %v",
			len(residual), residual)
	}
	if !strings.Contains(residual[0], "slow") ||
		!strings.Contains(residual[0], "deadline exceeded") {
		t.Fatalf("expected residual to name slow entry with deadline error, got %q", residual[0])
	}
	if elapsed < PerEntryTimeout {
		t.Fatalf("Run returned before per-entry timeout (%s); elapsed=%s",
			PerEntryTimeout, elapsed)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("Run took much longer than PerEntryTimeout; elapsed=%s", elapsed)
	}
}

// TestRun_PanicRecovery ensures one panicking teardown doesn't prevent the
// rest of the LIFO chain from running.
func TestRun_PanicRecovery(t *testing.T) {
	c := New()
	var ran []string
	var mu sync.Mutex
	c.Register("first", func(context.Context) error {
		mu.Lock()
		ran = append(ran, "first")
		mu.Unlock()
		return nil
	})
	c.Register("boom", func(context.Context) error {
		panic("umount kaboom")
	})
	c.Register("third", func(context.Context) error {
		mu.Lock()
		ran = append(ran, "third")
		mu.Unlock()
		return nil
	})

	residual := c.Run(context.Background())
	// LIFO: third → boom (panic) → first
	if len(ran) != 2 || ran[0] != "third" || ran[1] != "first" {
		t.Fatalf("expected panic to be contained; ran=%v", ran)
	}
	if len(residual) != 1 || !strings.Contains(residual[0], "boom") ||
		!strings.Contains(residual[0], "panic") {
		t.Fatalf("expected panic to surface in residual, got %v", residual)
	}
}

// TestRun_Idempotent asserts calling Run a second time is a no-op — the
// coordinator has already fired, so late registrations must not accumulate
// and running again must not re-invoke old callbacks.
func TestRun_Idempotent(t *testing.T) {
	c := New()
	var count atomic.Int32
	c.Register("x", func(context.Context) error {
		count.Add(1)
		return nil
	})
	c.Run(context.Background())
	c.Run(context.Background())
	if got := count.Load(); got != 1 {
		t.Fatalf("expected teardown to run exactly once, got %d", got)
	}
}

// TestRegister_AfterRunIsDropped confirms a Register call after the
// coordinator has already fired returns a no-op unregister and does not
// silently accumulate work that will never run.
func TestRegister_AfterRunIsDropped(t *testing.T) {
	c := New()
	c.Run(context.Background())

	var ran atomic.Bool
	drop := c.Register("late", func(context.Context) error {
		ran.Store(true)
		return nil
	})
	if c.Len() != 0 {
		t.Fatalf("expected Register after Run to be dropped; Len=%d", c.Len())
	}
	drop() // must not panic
	c.Run(context.Background())
	if ran.Load() {
		t.Fatalf("late registration must not run")
	}
}

// TestGlobal_SetGetClear tests the package-scoped coordinator handle used
// by build.go to install a per-run coordinator without threading pointers.
func TestGlobal_SetGetClear(t *testing.T) {
	// Cleanup guard for any lingering binding from prior tests in this file.
	defer Clear()

	if got := Get(); got != nil {
		t.Fatalf("expected clean initial state, got %p", got)
	}

	c := New()
	Set(c)
	if got := Get(); got != c {
		t.Fatalf("expected Get to return the set coordinator")
	}

	Clear()
	if got := Get(); got != nil {
		t.Fatalf("expected Get to return nil after Clear")
	}

	// Set(nil) is equivalent to Clear.
	Set(c)
	Set(nil)
	if got := Get(); got != nil {
		t.Fatalf("expected Get to return nil after Set(nil)")
	}
}

// TestRegister_NilCoordinatorIsNoop guards the register-side pattern
// `runctx.Get().Register(...)` — if Get returns nil (no build active),
// callers must be able to invoke Register on that nil without panic.
func TestRegister_NilCoordinatorIsNoop(t *testing.T) {
	var c *Coordinator // nil
	drop := c.Register("nil", func(context.Context) error {
		return fmt.Errorf("should not run")
	})
	drop() // no-op
	if got := c.Len(); got != 0 {
		t.Fatalf("nil coordinator Len should be 0, got %d", got)
	}
	if residual := c.Run(context.Background()); residual != nil {
		t.Fatalf("nil coordinator Run should return nil, got %v", residual)
	}
}

// TestRegister_ConcurrentDoesNotRace exercises the mutex — multiple
// goroutines register simultaneously; Run then invokes all in some LIFO
// order. Race detector catches any missed lock.
func TestRegister_ConcurrentDoesNotRace(t *testing.T) {
	c := New()
	var wg sync.WaitGroup
	const n = 50
	wg.Add(n)
	for i := 0; i < n; i++ {
		i := i
		go func() {
			defer wg.Done()
			c.Register(fmt.Sprintf("worker-%d", i), func(context.Context) error { return nil })
		}()
	}
	wg.Wait()
	if got := c.Len(); got != n {
		t.Fatalf("expected %d entries after concurrent Register, got %d", n, got)
	}
	if residual := c.Run(context.Background()); len(residual) != 0 {
		t.Fatalf("expected empty residual, got %v", residual)
	}
}
