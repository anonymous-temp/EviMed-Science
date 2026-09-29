# ---------------------------------------------------------------------------
# rules.R — the closed row-rule grammar (integration contract 2.1).
#
# Hidden knowledge:
#
# - **Nothing in a job is ever parsed as code.** Cohort rules, population
#   constraints and quality criteria used to be R expressions handed to
#   `eval(parse())`, which made every scenario a program: one string could read
#   any file the process could open and return it in an error message. A rule is
#   now a small JSON tree (`all`, `any`, `not`, `compare`, `between`, `in`,
#   `not_in`, `missing`, `present`) that this file validates and interprets. It
#   has no way to name a function, so there is nothing to sandbox.
# - **The grammar exists twice, on purpose.** `@evimed/domain`'s `vcrRules.mjs`
#   validates it before a job is queued and `tests/numeric/N23` runs the same
#   fixture file (`vcr-row-rules.json`) through both implementations, so a rule
#   the control plane accepts is a rule this engine reads the same way.
# - **Three-valued.** A missing value in a compared column is not "false": it
#   is "cannot tell" (NA). The Kleene connectives are R's own `&`, `|`, `!`,
#   which is exactly why the interpreter can stay vectorised. A cohort keeps
#   TRUE, excludes FALSE and reports NA as indeterminate; a population
#   constraint is violated only by FALSE.
# - **A rule that names a column the table does not have is refused by name.**
#   The old evaluator turned a misspelt column into "every row is
#   indeterminate" and reported a successful cohort of zero people; that is the
#   failure this validator exists to make impossible (EA-16).
# - Messages never repeat file content. A column name is echoed only after it
#   passed the identifier pattern, and the list of columns the table does have
#   is never printed.
# ---------------------------------------------------------------------------

# The domain owns the numbers (`rules.rowRule` in the snapshot); these are the
# same values for a build whose snapshot predates them.
.VCR_ROW_RULE_DEFAULT_LIMITS <- list(maxDepth = 8L, maxNodes = 200L, maxOperands = 32L, maxValues = 200L,
                                     maxStringLength = 500L, maxNameLength = 80L, maxNamedRules = 100L)
vcr_row_rule_limits <- function() {
  lim <- tryCatch(vcr_domain()$rules$rowRule$limits, error = function(e) NULL)
  utils::modifyList(.VCR_ROW_RULE_DEFAULT_LIMITS, if (is.list(lim)) lim else list())
}
VCR_ROW_RULE_OPS <- c("all", "any", "not", "compare", "between", "in", "not_in", "missing", "present")
VCR_ROW_COMPARATORS <- c("lt", "lte", "gt", "gte", "eq", "ne")
VCR_ROW_ORDERING <- c("lt", "lte", "gt", "gte")
.VCR_ROW_COL_RE <- "^[A-Za-z_][A-Za-z0-9_.]{0,63}$"
.VCR_RULE_KEYS <- list(
  all = list(keys = c("op", "operands"), required = "operands"),
  any = list(keys = c("op", "operands"), required = "operands"),
  not = list(keys = c("op", "operand"), required = "operand"),
  compare = list(keys = c("op", "column", "comparator", "value"), required = c("column", "comparator", "value")),
  between = list(keys = c("op", "column", "low", "high"), required = c("column", "low", "high")),
  `in` = list(keys = c("op", "column", "values"), required = c("column", "values")),
  not_in = list(keys = c("op", "column", "values"), required = c("column", "values")),
  missing = list(keys = c("op", "column"), required = "column"),
  present = list(keys = c("op", "column"), required = "column"))

.vcr_at <- function(path, key) if (nzchar(path)) paste0(path, ".", key) else key
.vcr_at_index <- function(path, i) sprintf("%s[%d]", path, i)
.vcr_is_object <- function(x) is.list(x) && !is.null(names(x))
.vcr_is_array <- function(x) is.list(x) && is.null(names(x))
.vcr_has <- function(node, key) key %in% names(node)
.vcr_is_finite_number <- function(v) is.numeric(v) && length(v) == 1L && is.finite(v)
.vcr_is_flag <- function(v) is.logical(v) && length(v) == 1L && !is.na(v)
.vcr_is_text <- function(v, max) is.character(v) && length(v) == 1L && !is.na(v) && nchar(v, type = "chars") <= max
.vcr_is_scalar <- function(v) .vcr_is_finite_number(v) || .vcr_is_flag(v) || (is.character(v) && length(v) == 1L && !is.na(v))

#' Every column a rule reads (without validating it).
vcr_rule_columns <- function(rule) {
  out <- character(0)
  walk <- function(node) {
    if (!is.list(node)) return(invisible(NULL))
    if (is.character(node$column) && length(node$column) == 1L) out <<- c(out, node$column)
    if (is.list(node$operands)) for (o in node$operands) walk(o)
    if (is.list(node$operand)) walk(node$operand)
  }
  walk(rule)
  unique(out)
}

#' Validate a row rule, mirroring `validateRowRule` in `@evimed/domain` (the
#' parity fixture `vcr-row-rules.json` holds the two to one verdict). Returns a
#' list of issues (`code`, `field`, `detail`), `field` being the path from the
#' rule's root (`""` for the root, `operands[1].column` below it, prefixed by
#' `path` when the rule sits inside a larger document); `list()` is a valid
#' rule. `columns`, when given, are the columns of the table it will run on.
vcr_validate_row_rule <- function(rule, columns = NULL, path = "") {
  issues <- list(); nodes <- 0L; stop_walk <- FALSE
  lim <- vcr_row_rule_limits()
  raise <- function(code, p, detail) issues[[length(issues) + 1L]] <<- vcr_issue(code, p, detail)

  walk <- function(node, p, depth) {
    if (stop_walk) return(invisible(NULL))
    nodes <<- nodes + 1L
    if (depth > lim$maxDepth) { raise("rule_too_deep", p, sprintf("A rule nests at most %d levels.", lim$maxDepth)); stop_walk <<- TRUE; return(invisible(NULL)) }
    if (nodes > lim$maxNodes) { raise("rule_too_large", p, sprintf("A rule has at most %d nodes.", lim$maxNodes)); stop_walk <<- TRUE; return(invisible(NULL)) }
    if (!.vcr_is_object(node)) { raise("rule_shape_invalid", p, "A rule node is an object."); return(invisible(NULL)) }
    if (.vcr_has(node, "expression")) {
      raise("rule_expression_forbidden", p, "Rules are data in a closed grammar; an expression is never parsed.")
      return(invisible(NULL))
    }
    op <- node$op
    if (!(is.character(op) && length(op) == 1L && !is.na(op))) {
      raise("rule_shape_invalid", .vcr_at(p, "op"), "A rule node names its op.")
      return(invisible(NULL))
    }
    if (!(op %in% VCR_ROW_RULE_OPS)) {
      raise("rule_op_unknown", .vcr_at(p, "op"), sprintf("Unknown op '%s'.", if (grepl("^[A-Za-z_]{1,24}$", op)) op else "?"))
      return(invisible(NULL))
    }
    spec <- .VCR_RULE_KEYS[[op]]
    for (k in names(node)) if (!(k %in% spec$keys)) raise("rule_shape_invalid", .vcr_at(p, k), sprintf("A %s node does not take that field.", op))
    for (k in spec$required) if (!.vcr_has(node, k)) raise("rule_shape_invalid", .vcr_at(p, k), sprintf("A %s node needs %s.", op, k))

    if (.vcr_has(node, "column")) {
      col <- node$column
      field <- .vcr_at(p, "column")
      if (!(is.character(col) && length(col) == 1L && !is.na(col) && grepl(.VCR_ROW_COL_RE, col))) {
        raise("rule_shape_invalid", field, "A column is a name of 1-64 letters, digits, '_' or '.', not starting with a digit.")
      } else if (!is.null(columns) && !(col %in% columns)) {
        raise("rule_column_unknown", field, sprintf("The table has no column '%s'.", col))
      }
    }
    if (op == "compare") {
      cmp <- node$comparator
      ordering <- is.character(cmp) && length(cmp) == 1L && cmp %in% VCR_ROW_ORDERING
      if (.vcr_has(node, "comparator") && !(is.character(cmp) && length(cmp) == 1L && cmp %in% VCR_ROW_COMPARATORS)) {
        raise("rule_shape_invalid", .vcr_at(p, "comparator"), "The comparator is lt, lte, gt, gte, eq or ne.")
      }
      if (.vcr_has(node, "value")) {
        v <- node$value
        ok <- if (ordering) .vcr_is_finite_number(v) else (.vcr_is_finite_number(v) || .vcr_is_text(v, lim$maxStringLength) || .vcr_is_flag(v))
        if (!ok) raise("rule_shape_invalid", .vcr_at(p, "value"),
                       if (ordering) "An ordering comparison needs a finite number." else "A compared value is a finite number, a short string or a boolean.")
      }
    } else if (op == "between") {
      for (k in c("low", "high")) {
        if (.vcr_has(node, k) && !.vcr_is_finite_number(node[[k]])) raise("rule_shape_invalid", .vcr_at(p, k), sprintf("%s is a finite number.", k))
      }
      if (.vcr_is_finite_number(node$low) && .vcr_is_finite_number(node$high) && node$low > node$high) {
        raise("rule_shape_invalid", .vcr_at(p, "high"), "high is not below low.")
      }
    } else if (op %in% c("in", "not_in")) {
      if (.vcr_has(node, "values")) {
        field <- .vcr_at(p, "values")
        vals <- node$values
        as_list <- if (.vcr_is_array(vals)) vals else if (is.atomic(vals) && length(vals) >= 1L) as.list(vals) else NULL
        if (is.null(as_list) || length(as_list) < 1L || length(as_list) > lim$maxValues) {
          raise("rule_shape_invalid", field, sprintf("values is a list of 1-%d scalars.", lim$maxValues))
        } else {
          for (i in seq_along(as_list)) {
            it <- as_list[[i]]
            if (!(.vcr_is_finite_number(it) || .vcr_is_flag(it) || .vcr_is_text(it, lim$maxStringLength))) {
              raise("rule_shape_invalid", .vcr_at_index(field, i - 1L), "A listed value is a finite number, a string or a boolean.")
            }
          }
        }
      }
    }
    if (op == "not") {
      if (.vcr_has(node, "operand")) walk(node$operand, .vcr_at(p, "operand"), depth + 1L)
    } else if (op %in% c("all", "any") && .vcr_has(node, "operands")) {
      ops <- node$operands
      if (!(.vcr_is_array(ops) && length(ops) >= 1L && length(ops) <= lim$maxOperands)) {
        raise("rule_shape_invalid", .vcr_at(p, "operands"), sprintf("operands is a list of 1-%d rules.", lim$maxOperands))
      } else {
        lp <- .vcr_at(p, "operands")
        for (i in seq_along(ops)) { if (stop_walk) break; walk(ops[[i]], .vcr_at_index(lp, i - 1L), depth + 1L) }
      }
    }
    invisible(NULL)
  }
  walk(rule, path, 1L)
  issues
}

#' Evaluate a validated row rule over a data frame. Returns a logical vector
#' the length of `df`, NA meaning "cannot tell". The semantics are the
#' domain's `evaluateRowRule`, cell by cell: a missing cell answers NA for
#' `compare`, `between`, `in` and `not_in`; equality and membership are strict
#' about type (a string never equals a number, so `eq` on a mismatched type is
#' FALSE and `ne` TRUE); ordering and `between` are defined for numeric cells
#' only and answer NA for a non-numeric cell; `all`/`any`/`not` are Kleene.
#' The rule must already have passed `vcr_validate_row_rule(rule, names(df))`;
#' an unknown column here is a bug in the caller and stops loudly rather than
#' returning NA.
vcr_eval_row_rule <- function(rule, df) {
  n <- nrow(df)
  col <- function(name) {
    if (!(name %in% names(df))) stop(sprintf("vcr_eval_row_rule: column '%s' is not in the table", name))
    x <- df[[name]]
    if (is.factor(x)) as.character(x) else x
  }
  same_type <- function(x, v) (is.numeric(x) && is.numeric(v)) || (is.character(x) && is.character(v)) || (is.logical(x) && is.logical(v))
  ev <- function(node) {
    op <- node$op
    if (op %in% c("all", "any")) {
      parts <- lapply(node$operands, ev)
      return(Reduce(if (op == "all") `&` else `|`, parts))
    }
    if (op == "not") return(!ev(node$operand))
    x <- col(node$column)
    if (op == "missing") return(is.na(x))
    if (op == "present") return(!is.na(x))
    out <- rep(NA, n)
    ok <- !is.na(x)
    if (op == "compare") {
      v <- node$value; cmp <- node$comparator
      if (cmp %in% c("eq", "ne")) {
        eq <- rep(FALSE, n)
        if (same_type(x, v)) eq[ok] <- x[ok] == v
        out[ok] <- if (cmp == "eq") eq[ok] else !eq[ok]
      } else if (is.numeric(x)) {
        xv <- as.numeric(x[ok])
        out[ok] <- switch(cmp, lt = xv < v, lte = xv <= v, gt = xv > v, gte = xv >= v)
      }
      return(out)
    }
    if (op == "between") {
      if (is.numeric(x)) out[ok] <- x[ok] >= node$low & x[ok] <= node$high
      return(out)
    }
    vals <- if (.vcr_is_array(node$values)) node$values else as.list(node$values)
    of_type <- function(pred) unlist(Filter(pred, vals), use.names = FALSE)
    hit <- rep(FALSE, n)
    if (is.numeric(x)) hit[ok] <- x[ok] %in% as.numeric(of_type(is.numeric))
    else if (is.character(x)) hit[ok] <- x[ok] %in% as.character(of_type(is.character))
    else if (is.logical(x)) hit[ok] <- x[ok] %in% as.logical(of_type(is.logical))
    res <- rep(NA, n)
    res[ok] <- if (op == "in") hit[ok] else !hit[ok]
    res
  }
  out <- ev(rule)
  if (length(out) == 1L && n != 1L) out <- rep(out, n)
  as.logical(out)
}

#' Find `expression` keys anywhere in a scenario. Returns the paths.
vcr_scenario_expression_paths <- function(x, path = "scenario") {
  out <- character(0)
  if (!is.list(x)) return(out)
  nms <- names(x)
  for (i in seq_along(x)) {
    p <- if (!is.null(nms) && nzchar(nms[i])) paste0(path, ".", nms[i]) else sprintf("%s[%d]", path, i - 1L)
    if (!is.null(nms) && identical(nms[i], "expression")) out <- c(out, p)
    out <- c(out, vcr_scenario_expression_paths(x[[i]], p))
  }
  out
}

#' Named rules `{ name, rule }` -> validated list, or issues (the domain's
#' `validateNamedRules`). Used by cohorts (`rules`), populations (`constraints`)
#' and quality (`criteria`).
vcr_named_rules <- function(items, columns, field, allow_empty = TRUE) {
  issues <- list()
  lim <- vcr_row_rule_limits()
  if (is.null(items)) return(list(rules = list(), issues = issues))
  if (!.vcr_is_array(items) || (!allow_empty && length(items) < 1L) || length(items) > lim$maxNamedRules) {
    return(list(rules = list(), issues = list(vcr_issue("rule_shape_invalid", field,
      sprintf("A list of named rules has %d-%d items.", if (allow_empty) 0L else 1L, lim$maxNamedRules)))))
  }
  out <- list()
  for (i in seq_along(items)) {
    it <- items[[i]]
    at <- .vcr_at_index(field, i - 1L)
    n0 <- length(issues)
    if (!.vcr_is_object(it)) {
      issues[[length(issues) + 1L]] <- vcr_issue("rule_shape_invalid", at, "A named rule is { name, rule }.")
      next
    }
    if (.vcr_has(it, "expression")) {
      issues[[length(issues) + 1L]] <- vcr_issue("rule_expression_forbidden", at, "Rules are data in a closed grammar; an expression is never parsed.")
      next
    }
    for (k in names(it)) if (!(k %in% c("name", "rule", "unknownAs"))) {
      issues[[length(issues) + 1L]] <- vcr_issue("rule_shape_invalid", .vcr_at(at, k), "A named rule is { name, rule }.")
    }
    nm <- it$name
    if (!(is.character(nm) && length(nm) == 1L && !is.na(nm) && nchar(nm) >= 1L && nchar(nm) <= lim$maxNameLength)) {
      issues[[length(issues) + 1L]] <- vcr_issue("rule_shape_invalid", .vcr_at(at, "name"), sprintf("A rule name is 1-%d characters.", lim$maxNameLength))
    }
    if (!.vcr_has(it, "rule")) issues[[length(issues) + 1L]] <- vcr_issue("rule_shape_invalid", .vcr_at(at, "rule"), "A named rule carries its rule.")
    else issues <- c(issues, vcr_validate_row_rule(it$rule, columns, .vcr_at(at, "rule")))
    if (length(issues) == n0) out[[length(out) + 1L]] <- it
  }
  list(rules = out, issues = issues)
}

# --- formulas from column names, never from text ----------------------------------------------
#
# A column name comes from a file somebody uploaded, so it is data, never code.
# `as.formula(paste(...))` and `reformulate()` both *parse* the names they are
# given, and a header written `bmi+system('...')` was executed that way (merge
# verification, 2026-09-29). Every model formula over data columns is built here
# as a call object whose terms are `as.name()` symbols: a symbol names a column,
# whatever characters it holds, and nothing is ever parsed.

#' The sum of terms `a + b + c` as a call, each a symbol naming one column.
.vcr_term_sum <- function(terms) {
  if (!length(terms)) return(NULL)
  Reduce(function(acc, term) call("+", acc, as.name(term)), terms[-1L], as.name(terms[[1L]]))
}

#' `response ~ fixed + terms`, or `response ~ (terms)^2` with `pairwise = TRUE`.
#' `fixed` names model terms the engine chose (an arm column, say); `terms` are
#' data column names. Both become symbols; the environment is empty of
#' anything but base arithmetic.
vcr_model_formula <- function(response, terms = character(), fixed = character(), pairwise = FALSE) {
  terms <- as.character(terms); fixed <- as.character(fixed)
  data_part <- .vcr_term_sum(terms)
  if (pairwise && !is.null(data_part)) data_part <- call("^", call("(", data_part), 2)
  rhs <- .vcr_term_sum(fixed)
  rhs <- if (is.null(rhs)) data_part else if (is.null(data_part)) rhs else call("+", rhs, data_part)
  if (is.null(rhs)) rhs <- 1
  f <- call("~", as.name(response), rhs)
  stats::as.formula(f, env = new.env(parent = baseenv()))
}
