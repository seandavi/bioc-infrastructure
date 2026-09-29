# Evidence for the registry switch

Scripts behind the measurements on [the registry switch plan](../../registry-switch.qmd).
Run from an empty directory; they read and write files in the current directory.

```sh
./fetch.sh          # every PACKAGES index and VIEWS, both sides, release and devel; status of .gz/.rds/Archive
python3 diff.py     # package sets, versions, dependency-field and VIEWS-field differences
python3 depdiff.py  # which dependency differences are formatting and which are real
Rscript deps.R <repo-url> <bioc-version>   # packages whose hard dependencies can't be resolved
```

`diff.py` expects the files `fetch.sh` writes. The registry's propagation index is
`https://bioc-registry.seandavi.workers.dev/data/prop/{bioc,bioc-release}/index.json`.
