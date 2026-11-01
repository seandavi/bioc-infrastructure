# Scheduling

Two timers, deliberately shipped as a pair.

| Unit | Cadence | What it does |
|---|---|---|
| `bioc-sync` | hourly | `RSYNC_SRC=... ./sync.sh` — pull the delta, push what moved, purge those URLs |
| `bioc-reconcile` | weekly | `RECONCILE=1 ./sync.sh` — `rclone check --checksum`, report drift |

The two mirror jobs share a lock (`flock` on `$XDG_RUNTIME_DIR/bioc-mirror.lock`): the hourly sync skips its run with exit 0 if the reconcile holds it, and the reconcile waits up to 2 h for a running sync before starting. They used to declare `Conflicts=` on each other, which made systemd *kill* whichever was running when the other started; the multi-hour reconcile never survived the next hourly sync
([bioc-edge#5](https://github.com/seandavi/bioc-edge/issues/5), [#6](https://github.com/seandavi/bioc-edge/issues/6)).

Both carry `OnFailure=bioc-notify@%N.service`, so a failed run files (or comments on)
a GitHub issue titled `<unit> is failing` via `../notify-failure.sh` — full journal for
that run plus whatever `sync.sh` log files it left on disk, capped only against
GitHub's body-size limit. One operator has access to this box, so the body isn't
trimmed for brevity. `gh` auth already lives in `~/.config/gh` on this host; nothing
else to provision.

They are a pair because the delta sync is what *creates* the need for reconciliation.
`RSYNC_SRC` mode trusts rsync's delta and never reads the bucket back, so a failed upload
diverges silently and permanently. Scheduling the sync without the check would be
shipping the failure mode without the detector; scheduling the check without the sync
would reconcile a mirror nothing is updating.

## Installed

On onclappc02 since 2026-09, and since 2026-11-01 from the operations clone of `main` at
`/data/davsean/bioc-ops/bioc-infrastructure`, not from a development checkout. The unit files
hard-code that path. Each unit in `~/.config/systemd/user` is a symlink to its file here:

```sh
O=/data/davsean/bioc-ops/bioc-infrastructure/packages/edge/systemd
for u in bioc-sync.service bioc-sync.timer bioc-reconcile.service bioc-reconcile.timer bioc-notify@.service; do
  ln -sfn "$O/$u" ~/.config/systemd/user/"$u"
done
systemctl --user daemon-reload
systemctl --user enable --now bioc-sync.timer bioc-reconcile.timer
loginctl enable-linger "$USER"     # timers must survive logout
```

`enable-linger` is not optional: without it user timers stop when the last session ends,
so the sync would run only while someone is logged in. The units read
`packages/edge/.env` in the ops clone (gitignored; `../make-env.sh` writes it), and reach the
upstream docroot host over SSH with a key the unit can read without an agent.

To deploy a change to these units or to `sync.sh`: merge to `main`, then
`git -C /data/davsean/bioc-ops/bioc-infrastructure pull` and, for unit-file changes,
`systemctl --user daemon-reload`.

## Verify

```sh
systemctl --user list-timers 'bioc-*'
journalctl --user -u bioc-sync.service -n 50
systemctl --user start bioc-reconcile.service   # run one now, out of band
```

## Cost note

`bioc-reconcile` reads and hashes the entire local mirror — 453 GB — to compare against
R2 ETags. That is why it is weekly and offset to Sunday 04:00. Running it hourly would
saturate the disk for no benefit; the hourly path deliberately never touches the bucket.
