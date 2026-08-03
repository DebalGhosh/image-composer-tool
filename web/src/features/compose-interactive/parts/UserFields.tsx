import { Combobox, type ComboboxItem } from '@/components/controls/Combobox'
import {
  TextInput,
  fieldLabelClass,
  fieldLabelStyle,
} from '@/components/controls/Select'
import type { UserConfig } from '@/store'

const HASH_ALGO_ITEMS: ComboboxItem[] = [
  { value: 'sha512', label: 'sha512' },
  { value: 'bcrypt', label: 'bcrypt' },
]

/**
 * The six default-user fields.
 *
 * Split out of UserBlock, which was 159 lines — over the 150-line ceiling. The
 * enable/disable toggle and the Collapsible stay in UserBlock; this is only the
 * form grid.
 *
 * ⚠️ The grid uses `@max-pane-2col:` — a CONTAINER query, not a viewport
 * breakpoint. See .claude/UI-LAYOUT.md: this content lives in a percentage-sized
 * resizable pane, so `md:` would measure the wrong box.
 */
export function UserFields({
  displayUser,
  patch,
}: {
  /** The user to render against. Never null — see UserBlock's close-animation
   *  fallback: `user` flips to null the moment the checkbox is unchecked, but
   *  the fields must keep rendering for the ~260ms exit animation. */
  displayUser: UserConfig
  patch: (p: Partial<UserConfig>) => void
}) {
  return (
        <div
          className="@max-pane-2col:grid-cols-1 grid grid-cols-2 gap-4 rounded-md border p-4"
          style={{
            borderColor: 'var(--border-color)',
            background: 'var(--input-background)',
          }}
        >
          <div>
            <label
              htmlFor="i-user-name"
              className={fieldLabelClass}
              style={fieldLabelStyle}
            >
              Name
            </label>
            <TextInput
              id="i-user-name"
              value={displayUser.name}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder="user"
            />
          </div>
          <div>
            <label
              htmlFor="i-user-password"
              className={fieldLabelClass}
              style={fieldLabelStyle}
            >
              Password
            </label>
            <TextInput
              id="i-user-password"
              type="password"
              value={displayUser.password}
              onChange={(e) => patch({ password: e.target.value })}
              placeholder="(hashed on server)"
              autoComplete="new-password"
            />
          </div>
          <div>
            <label
              id="i-user-hashalgo-label"
              className={fieldLabelClass}
              style={fieldLabelStyle}
            >
              Hash algorithm
            </label>
            <Combobox
              ariaLabelledBy="i-user-hashalgo-label"
              value={displayUser.hashAlgo}
              items={HASH_ALGO_ITEMS}
              placeholder="sha512"
              onChange={(v) =>
                patch({ hashAlgo: v === 'bcrypt' ? 'bcrypt' : 'sha512' })
              }
            />
          </div>
          <div>
            <label
              htmlFor="i-user-groups"
              className={fieldLabelClass}
              style={fieldLabelStyle}
            >
              Groups (comma-separated)
            </label>
            <TextInput
              id="i-user-groups"
              value={displayUser.groups.join(', ')}
              onChange={(e) =>
                patch({
                  groups: e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter((s) => s.length > 0),
                })
              }
              placeholder="sudo, docker"
            />
          </div>
          <div>
            <label
              htmlFor="i-user-home"
              className={fieldLabelClass}
              style={fieldLabelStyle}
            >
              Home
            </label>
            <TextInput
              id="i-user-home"
              value={displayUser.home}
              onChange={(e) => patch({ home: e.target.value })}
              placeholder="/home/user"
            />
          </div>
          <div>
            <label
              htmlFor="i-user-shell"
              className={fieldLabelClass}
              style={fieldLabelStyle}
            >
              Shell
            </label>
            <TextInput
              id="i-user-shell"
              value={displayUser.shell}
              onChange={(e) => patch({ shell: e.target.value })}
              placeholder="/bin/bash"
            />
          </div>
          <label
            className="@max-pane-2col:col-span-1 col-span-2 flex cursor-pointer items-center gap-3 text-sm"
            style={{ color: 'var(--font-color)' }}
          >
            <input
              type="checkbox"
              checked={displayUser.sudo}
              onChange={(e) => patch({ sudo: e.target.checked })}
              className="h-4 w-4 accent-[var(--classic-blue)] cursor-pointer"
            />
            Passwordless sudo
          </label>
        </div>
  )
}
