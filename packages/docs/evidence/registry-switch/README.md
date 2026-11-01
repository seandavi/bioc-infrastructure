# Evidence for the registry switch

Scripts behind the measurements on [the registry switch plan](../../registry-switch.qmd).
Run from an empty directory; they read and write files in the current directory.

```sh
./fetch.sh          # every PACKAGES index and VIEWS, both sides, release and devel; status of .gz/.rds/Archive
python3 diff.py     # package sets, versions, dependency-field and VIEWS-field differences
python3 depdiff.py  # which dependency differences are formatting and which are real
Rscript deps.R <repo-url> <bioc-version>   # packages whose hard dependencies can't be resolved
python3 binwhy.py   # why each binary bioconductor.org serves is missing from the registry
python3 gatecheck.py bioc DOSE biomaRt     # would r-universe's current build propagate, and if not, which rule blocks it
```

`diff.py` expects the files `fetch.sh` writes. `binwhy.py` and `gatecheck.py` also need the registry's propagation index, saved as
`idx-{universe}.json` from `https://bioc-registry.seandavi.workers.dev/data/prop/{universe}/index.json`,
and its latest r-universe observation, saved as `obs-{universe}.json` from
`/data/<key>`, where `key` comes from `/data/state/{universe}/latest`.
