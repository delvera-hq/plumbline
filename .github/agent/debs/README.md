# Pinned sandbox packages

agent.yml installs `bubblewrap` and `socat` from Ubuntu's archive. If the archive can't be reached (as in the
Canonical DNS outage of 2026-11-11), it installs these copies instead, after checking them against `SHA256SUMS`.
`libwrap0` is installed only if the runner lacks it, since `socat` needs it.

They are Ubuntu 24.04 (noble) amd64 packages from `noble-updates` (and `noble` for `libwrap0`). Their hashes were
checked against the `Packages` indexes listed in each suite's `InRelease`, whose signatures were verified with Ubuntu
Archive Automatic Signing Key (2018), fingerprint `F6EC B376 2474 EDA9 D21B  7022 8719 20D1 991B C93C`.

To refresh them, repeat that check, replace the files, regenerate `SHA256SUMS` with `shasum -a 256 *.deb`, and ship a
new template version. They only matter during an outage, so falling a little behind Ubuntu's updates is acceptable.
