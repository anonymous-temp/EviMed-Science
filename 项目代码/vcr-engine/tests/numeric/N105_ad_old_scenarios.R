# N105 — what 1.2.0 did not change (plan R23, R25, 2026-11-09)
#
# Seven scenarios of the beta_logit family as they were stated before the effect distribution and the people table existed, run at one seed with the
# code of the release before this one (patients.progression 1.1.0, recorded on 2026-11-09 before the engine was touched). Their output hashes (the
# measures, counts and conclusion the control plane files) are the same to the byte: a typical study, a new study, posterior draws, a symptomatic, a
# disease-modifying and a combined effect, the analysis of covariance, no dropout and a stated population.

vcr_case("N105a", c("AC-31", "AC-04"), function() {
  P <- function(v, basis = "assumed") list(value = v, basis = basis)
  sc <- function(unc, treatment = NULL, n = 60L, analysis = NULL, extra = list()) {
    s <- c(list(endpoint = list(type = "continuous", unit = "points"), design = list(nTreat = n, nControl = n), timeUnit = "weeks", visits = c(0, 13, 26, 52, 78),
      model = list(family = "beta_logit", parameterSet = list(id = "camd-adas-cog-11", version = "adsim-3.0"), uncertainty = unc)), extra)
    if (!is.null(treatment)) s$treatment <- treatment
    if (!is.null(analysis)) s$analysis <- analysis
    s
  }
  sym <- list(symptomatic = list(pointsAt = P(-2.5), atWeek = 26, referenceAdas = 25, et50Weeks = P(8)))
  dm <- list(diseaseModifying = list(fraction = P(0.3)))
  recorded <- list(
    null_new = list(sc("new_study"), "3d355061d1e5a8a507a86121e6f187eff096de74a1028ae03e60be05e5294f42"),
    sym_typical = list(sc("typical_study", sym), "116af903742e38705c1b0664c2d495a15ec3c13023a8e9da89957bdceb28f6fb"),
    dm_new = list(sc("new_study", dm), "61987d486bea484b5d0adfe47fc2e351a5b6a6105c6d4bfc9249c07e06d1c5e2"),
    both_post = list(sc("posterior_draws", c(sym, dm)), "6d372f38430963763c42a59dc8b44d216652f16bc67c3ae2c283394cb6968bad"),
    sym_ancova = list(sc("new_study", sym, analysis = list(kind = "ancova", visit = 52)), "ed8bc1f2d927fb6caa284da7a9b1f381b7bd724914c25765b91ef7755958a69a"),
    dm_nodrop = list(sc("typical_study", dm, extra = list(dropoutModel = "none")), "8167a54b8a41bf3053341d748a9a29351f65edff379578db38a0fffbdd4823aa"),
    sym_pop = list(sc("new_study", sym, extra = list(population = list(mmseRange = list(value = c(18, 24), basis = "assumed"), femaleShare = P(0.6)))), "32a6c7b7a727be8a56aa3d23f0db918747a9b4be2ad493a13ed52cd4eb663361"))
  got <- vapply(recorded, function(x) vcr_output_hash(vcr_test_run(vcr_test_job("patients.progression", x[[1]], seed = 20261109L, replicates = 600L))), character(1))
  want <- vapply(recorded, function(x) x[[2]], character(1))
  list(pass = identical(unname(got), unname(want)),
       detail = sprintf("seven beta_logit scenarios of the 1.1.0 release at seed 20261109 (600 trials): %d of 7 output hashes equal the recorded ones (%s)",
                        sum(unname(got) == unname(want)), paste(sprintf("%s %s", names(got), substr(got, 1, 8)), collapse = ", ")))
})

vcr_case("N105b", c("AC-31", "AC-04"), function() {
  P <- function(v, basis = "assumed") list(value = v, basis = basis)
  sym <- list(symptomatic = list(pointsAt = P(-2.5), atWeek = 26, referenceAdas = 25, et50Weeks = P(8)))
  inst <- .n103_instantiate(300L, 10501L); input <- .n103_input(inst, "res_n105b:progression-people")
  on_record <- .n103_run("resampled_trials", input, sym, seed = 10502L, n = 40L, replicates = 300L)
  scen <- function(unc) list(endpoint = list(type = "continuous", unit = "points"), design = list(nTreat = 60L, nControl = 60L), timeUnit = "weeks", visits = c(0, 13, 26, 52, 78),
    model = list(family = "beta_logit", parameterSet = list(id = "camd-adas-cog-11", version = "adsim-3.0"), uncertainty = unc), treatment = sym)
  modes <- vapply(c("new_study", "typical_study", "posterior_draws"), function(u) vcr_test_run(vcr_test_job("patients.progression", scen(u), seed = 20261109L, replicates = 600L))$diagnostics$progression$uncertainty, character(1))
  recorded_hash <- "b5b6287a08fa562b20577b2000a92941a123433ad6f907521172acb75dc5b293"
  got <- vcr_output_hash(on_record)
  list(pass = identical(on_record$diagnostics$progression$uncertainty, "fixed_study") && identical(unname(modes), c("new_study", "typical_study", "posterior_draws")) && identical(got, recorded_hash),
       detail = sprintf("a resampled_trials run on a people record states its study as fixed_study (the old code wrote new_study, which says one study is drawn per trial); runs with no record keep stating their own mode (%s); output hash of the record run %s (equal to the one recorded with the code before the change)",
                        paste(modes, collapse = "/"), got))
})
