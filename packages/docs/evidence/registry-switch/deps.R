# Unresolvable hard deps (Depends/Imports/LinkingTo) in a software repo, given CRAN + Bioc data repos.
args <- commandArgs(TRUE); sw <- args[1]; ver <- args[2]
base <- sprintf("https://bioconductor.org/packages/%s", ver)
repos <- c(SW = sw, ANN = paste0(base, "/data/annotation"), EXP = paste0(base, "/data/experiment"),
           WF = paste0(base, "/workflows"), CRAN = "https://cloud.r-project.org")
options(timeout = 120)
ap <- available.packages(repos = repos, type = "source", filters = list())
av <- rownames(ap); base_pkgs <- rownames(installed.packages(priority = "base"))
sw_ap <- ap[ap[, "Repository"] == paste0(sw, "/src/contrib"), , drop = FALSE]
deps <- tools::package_dependencies(rownames(sw_ap), db = ap, which = c("Depends", "Imports", "LinkingTo"))
bad <- Filter(length, lapply(deps, function(d) setdiff(d, c(av, base_pkgs, "R"))))
cat(sprintf("%s: %d packages, %d with unresolvable hard deps\n", sw, nrow(sw_ap), length(bad)))
if (length(bad)) print(head(bad, 15))
