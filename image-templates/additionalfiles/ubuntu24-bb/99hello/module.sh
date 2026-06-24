check() { return 0; }
depends() { echo systemd; return 0; }
install() {
    inst_simple "$moddir/hello.sh" /usr/local/sbin/hello.sh
    inst_hook initqueue/settled 99 "$moddir/hello-run.sh"
}
