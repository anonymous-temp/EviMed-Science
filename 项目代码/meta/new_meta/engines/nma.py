"""Frequentist contrast-based Network Meta-Analysis engine.

Implements weighted least-squares NMA with full league table generation,
SUCRA ranking, node-splitting inconsistency tests, and network geometry
characterisation.  All computations use numpy/scipy; no LLM involved.
"""
from __future__ import annotations

from collections import defaultdict
from itertools import combinations
import math
from typing import Any

import numpy as np
from pydantic import BaseModel, Field, model_validator
from scipy import optimize, stats

from new_meta.schemas.meta_result import StudyEffect, NMAContrast, NMAResult


class MultiArmCovarianceError(ValueError):
    """Raised when dependent contrasts are supplied as if independent."""


# ---------------------------------------------------------------------------
# NMA Engine
# ---------------------------------------------------------------------------

class NMAEngine:
    """Frequentist contrast-based Network Meta-Analysis.

    The engine takes a list of study-level contrasts (log effect sizes and
    their variances) together with the full treatment list and a designated
    reference treatment, then fits a weighted-least-squares model to
    estimate all relative treatment effects.

    Parameters
    ----------
    contrasts : list[dict]
        Each dict must contain:
        - ``treatment``  : name of the experimental arm
        - ``comparator`` : name of the control/comparator arm
        - ``yi``         : point estimate (log scale, e.g. log-OR)
        - ``vi``         : variance of *yi*
        - ``study_id``   : unique study identifier
    treatments : list[str]
        Complete list of treatment names present in the network.
    reference : str
        The reference treatment against which all basic parameters are
        defined.
    """

    # -----------------------------------------------------------------
    # Construction
    # -----------------------------------------------------------------

    def __init__(
        self,
        contrasts: list[dict[str, Any]],
        treatments: list[str],
        reference: str,
        outcome_direction: str = "lower",
    ) -> None:
        if reference not in treatments:
            raise ValueError(
                f"Reference treatment '{reference}' is not in the treatments list."
            )
        if len(contrasts) == 0:
            raise ValueError("At least one contrast is required.")
        if outcome_direction not in {"lower", "higher"}:
            raise ValueError("outcome_direction must be 'lower' or 'higher'")

        self.contrasts = contrasts
        self.treatments = list(treatments)
        self.reference = reference
        self.outcome_direction = outcome_direction

        # Non-reference treatments in stable order
        self._active: list[str] = [t for t in self.treatments if t != reference]
        self._trt_to_idx: dict[str, int] = {
            t: i for i, t in enumerate(self._active)
        }
        self._n_params: int = len(self._active)

        # Build design / weight / outcome vectors
        self._X: np.ndarray  # (m, p)
        self._W: np.ndarray  # (m, m)
        self._V: np.ndarray  # (m, m) sampling covariance
        self._y: np.ndarray  # (m,)
        self._study_ids: list[str] = []
        self._build_matrices()

        # Populated after fit()
        self._beta: np.ndarray | None = None       # (p,)
        self._var_beta: np.ndarray | None = None    # (p, p)
        self._fitted: bool = False

    # -----------------------------------------------------------------
    # Internal – matrix construction
    # -----------------------------------------------------------------

    def _build_matrices(self) -> None:
        """Construct X (design), W (weight) and y (outcome) from contrasts.

        Each contrast encodes ``treatment vs comparator``.  The design matrix
        has one column per non-reference treatment.  For contrast *i*:

        * If treatment *A* vs comparator *B*:
            - Column for *A* gets +1 (unless *A* is reference -> 0)
            - Column for *B* gets -1 (unless *B* is reference -> 0)

        This parameterises the model so that beta_j = d_{j,ref}.
        """
        m = len(self.contrasts)
        p = self._n_params
        X = np.zeros((m, p), dtype=float)
        y = np.zeros(m, dtype=float)
        variances = np.zeros(m, dtype=float)

        for i, c in enumerate(self.contrasts):
            trt = c["treatment"]
            comp = c["comparator"]
            yi = float(c["yi"])
            vi = float(c["vi"])

            if trt not in self.treatments or comp not in self.treatments:
                raise ValueError(
                    f"Contrast {i} uses treatment outside the declared network: {trt!r} vs {comp!r}."
                )
            if trt == comp:
                raise ValueError(f"Contrast {i} compares a treatment with itself: {trt!r}.")

            if vi <= 0:
                raise ValueError(
                    f"Contrast {i} (study '{c.get('study_id', '?')}') has "
                    f"non-positive variance vi={vi}."
                )

            # Design matrix row: encode treatment – comparator
            if trt != self.reference:
                X[i, self._trt_to_idx[trt]] = 1.0
            if comp != self.reference:
                X[i, self._trt_to_idx[comp]] = -1.0

            y[i] = yi
            variances[i] = vi
            self._study_ids.append(c.get("study_id", f"study_{i}"))

        V = np.diag(variances)
        grouped: dict[str, list[int]] = defaultdict(list)
        for index, study_id in enumerate(self._study_ids):
            grouped[str(study_id)].append(index)
        for study_id, indices in grouped.items():
            if len(indices) < 2:
                continue
            for left_position, left in enumerate(indices):
                for right in indices[left_position + 1:]:
                    covariance = self._within_study_covariance(
                        self.contrasts[left],
                        self.contrasts[right],
                    )
                    if covariance is None:
                        raise MultiArmCovarianceError(
                            f"multi-arm study {study_id} has dependent contrasts but no explicit covariance"
                        )
                    limit = math.sqrt(variances[left] * variances[right])
                    if not math.isfinite(covariance) or abs(covariance) >= limit:
                        raise MultiArmCovarianceError(
                            f"multi-arm study {study_id} covariance {covariance} is not positive-definite"
                        )
                    V[left, right] = covariance
                    V[right, left] = covariance
        try:
            W = np.linalg.inv(V)
        except np.linalg.LinAlgError as exc:
            raise MultiArmCovarianceError("within-study sampling covariance matrix is singular") from exc
        if np.any(np.linalg.eigvalsh(V) <= 0):
            raise MultiArmCovarianceError("within-study sampling covariance matrix is not positive-definite")
        self._X = X
        self._V = V
        self._W = W
        self._y = y

    @staticmethod
    def _within_study_covariance(left: dict[str, Any], right: dict[str, Any]) -> float | None:
        left_id = str(left.get("contrast_id") or "")
        right_id = str(right.get("contrast_id") or "")
        left_map = left.get("covariance_with") if isinstance(left.get("covariance_with"), dict) else {}
        right_map = right.get("covariance_with") if isinstance(right.get("covariance_with"), dict) else {}
        if right_id and right_id in left_map:
            return float(left_map[right_id])
        if left_id and left_id in right_map:
            return float(right_map[left_id])
        left_shared = left.get("shared_comparator_variance")
        right_shared = right.get("shared_comparator_variance")
        if (
            left_shared is not None
            and right_shared is not None
            and left.get("comparator") == right.get("comparator")
        ):
            if not np.isclose(float(left_shared), float(right_shared), rtol=1e-8, atol=1e-12):
                raise MultiArmCovarianceError("shared comparator variance disagrees within a multi-arm study")
            return float(left_shared)
        return None

    def _random_effect_covariance(self, tau_squared: float) -> np.ndarray:
        """Add consistent multi-arm heterogeneity covariance to sampling error."""
        tau_squared = float(tau_squared)
        if tau_squared < 0:
            raise ValueError("tau_squared cannot be negative")
        random_structure = np.eye(len(self.contrasts), dtype=float)
        grouped: dict[str, list[int]] = defaultdict(list)
        for index, study_id in enumerate(self._study_ids):
            grouped[str(study_id)].append(index)
        for indices in grouped.values():
            if len(indices) < 2:
                continue
            for left_position, left in enumerate(indices):
                for right in indices[left_position + 1:]:
                    random_structure[left, right] = 0.5
                    random_structure[right, left] = 0.5
        return self._V + tau_squared * random_structure

    # -----------------------------------------------------------------
    # Fitting
    # -----------------------------------------------------------------

    def fit(self) -> NMAResult:
        """Fit the frequentist NMA model via weighted least squares.

        Solves::

            beta = (X' W X)^{-1} X' W y
            Var(beta) = (X' W X)^{-1}

        Returns
        -------
        NMAResult
            Populated with league table, SUCRA rankings, global
            inconsistency p-value and network geometry.

        Raises
        ------
        np.linalg.LinAlgError
            If the design matrix is rank-deficient (disconnected network).
        """
        X, W, y = self._X, self._W, self._y

        XtWX = X.T @ W @ X
        XtWy = X.T @ W @ y

        # Check for singular / near-singular matrix
        try:
            var_beta = np.linalg.inv(XtWX)
        except np.linalg.LinAlgError:
            raise np.linalg.LinAlgError(
                "Design matrix X'WX is singular.  The treatment network may "
                "be disconnected or have insufficient contrasts."
            )

        beta = var_beta @ XtWy

        self._beta = beta
        self._var_beta = var_beta
        self._fitted = True

        # Assemble result
        lt = self.league_table()
        sucra_scores = self.sucra()
        geometry = self.network_geometry()

        design_by_treatment = self._design_by_treatment_inconsistency()
        inconsistency_p = design_by_treatment.get("p_value")

        return NMAResult(
            treatments=self.treatments,
            reference=self.reference,
            model="fixed",
            tau_squared=0.0,
            tau_estimator="none",
            ranking_direction=self.outcome_direction,
            league_table=lt,
            sucra_rankings=sucra_scores,
            inconsistency_p=inconsistency_p,
            network_geometry=geometry,
            diagnostics={
                **self._fit_diagnostics(),
                "design_by_treatment": design_by_treatment,
            },
        )

    # -----------------------------------------------------------------
    # League table
    # -----------------------------------------------------------------

    def league_table(self) -> list[NMAContrast]:
        """Generate all pairwise NMA contrasts from the fitted model.

        For two non-reference treatments *A* and *B*:

        * ``d_{A,B} = beta_A - beta_B``
        * ``Var(d_{A,B}) = var_A + var_B - 2 cov(A, B)``

        For treatment *A* vs reference:

        * ``d_{A,ref} = beta_A``
        * ``Var(d_{A,ref}) = var_beta[A, A]``

        Returns a list of :class:`NMAContrast` objects sorted by
        (treatment, comparator).
        """
        self._ensure_fitted()

        results: list[NMAContrast] = []

        for trt_a, trt_b in combinations(self.treatments, 2):
            effect, var = self._pairwise_estimate(trt_a, trt_b)
            se = np.sqrt(max(var, 0.0))
            ci_lower = effect - 1.96 * se
            ci_upper = effect + 1.96 * se
            z = effect / se if se > 0 else 0.0
            p_value = float(2 * (1 - stats.norm.cdf(abs(z))))

            results.append(NMAContrast(
                treatment=trt_a,
                comparator=trt_b,
                effect=float(effect),
                ci_lower=float(ci_lower),
                ci_upper=float(ci_upper),
                p_value=p_value,
            ))

        results.sort(key=lambda c: (c.treatment, c.comparator))
        return results

    def _pairwise_estimate(self, trt_a: str, trt_b: str) -> tuple[float, float]:
        """Return (effect, variance) for the contrast trt_a vs trt_b.

        The contrast is defined as d_{A} - d_{B} where d_{X} is the basic
        parameter vs reference (zero for the reference itself).
        """
        beta = self._beta
        V = self._var_beta

        def _param(trt: str) -> tuple[float, int | None]:
            """Return (beta value, index) for a treatment."""
            if trt == self.reference:
                return 0.0, None
            idx = self._trt_to_idx[trt]
            return float(beta[idx]), idx

        val_a, idx_a = _param(trt_a)
        val_b, idx_b = _param(trt_b)

        effect = val_a - val_b

        # Variance via delta method
        if idx_a is None and idx_b is None:
            # Both are reference (should not happen)
            var = 0.0
        elif idx_a is None:
            var = float(V[idx_b, idx_b])
        elif idx_b is None:
            var = float(V[idx_a, idx_a])
        else:
            var = float(V[idx_a, idx_a] + V[idx_b, idx_b] - 2 * V[idx_a, idx_b])

        return effect, var

    # -----------------------------------------------------------------
    # SUCRA
    # -----------------------------------------------------------------

    def sucra(self) -> dict[str, float]:
        """Compute Surface Under the Cumulative Ranking curve for each treatment.

        For each pair (A, B) the probability P(A better than B) is calculated
        from the normal distribution of the contrast d_{A,B}.  Then for each
        treatment, cumulative rank probabilities are derived and SUCRA is

            SUCRA_j = sum_{r=1}^{k-1} P(rank <= r) / (k - 1)

        where *k* is the total number of treatments.

        A SUCRA close to 1 indicates the treatment is likely the best; close
        to 0 indicates the worst.

        Returns
        -------
        dict[str, float]
            Treatment name to SUCRA score mapping.
        """
        self._ensure_fitted()

        k = len(self.treatments)
        if k < 2:
            return {self.treatments[0]: 1.0} if k == 1 else {}

        # prob_better[i][j] = P(treatment_i is better than treatment_j)
        # "better" means *smaller* effect (e.g. lower log-OR for harm outcome
        # is left to the user; here we follow the standard convention that a
        # *negative* effect favours the treatment in the numerator).
        prob_better = np.zeros((k, k), dtype=float)

        for i in range(k):
            for j in range(k):
                if i == j:
                    continue
                trt_i = self.treatments[i]
                trt_j = self.treatments[j]
                effect, var = self._pairwise_estimate(trt_i, trt_j)
                se = np.sqrt(max(var, 1e-30))
                if self.outcome_direction == "lower":
                    prob_better[i, j] = float(stats.norm.cdf(-effect / se))
                else:
                    prob_better[i, j] = float(stats.norm.cdf(effect / se))

        # Rank probabilities via counting
        # P(treatment i has rank r) approximated from prob_better matrix
        # Using the probabilistic approach: the number of treatments that
        # are better than i follows a Poisson-binomial-like distribution.
        # We approximate with cumulative probabilities.
        sucra_scores: dict[str, float] = {}

        for i in range(k):
            # P(treatment i beats treatment j) for all j != i
            p_beats = [prob_better[i, j] for j in range(k) if j != i]
            # Expected number of treatments that i beats
            # Cumulative rank probability: P(rank <= r) = P(beats >= k - r)
            # SUCRA = mean of P(rank <= r) for r = 1 .. k-1
            # which equals mean of p_beats (expected proportion beaten)
            sucra_val = float(np.mean(p_beats))
            sucra_scores[self.treatments[i]] = round(sucra_val, 4)

        return sucra_scores

    # -----------------------------------------------------------------
    # Node-splitting inconsistency test
    # -----------------------------------------------------------------

    def node_splitting(self) -> dict[str, dict[str, float]]:
        """Perform node-splitting to test local inconsistency.

        For every comparison that has *both* direct and indirect evidence,
        the method:

        1. Estimates the **direct** effect by pooling only the studies
           that directly compare the two treatments (inverse-variance
           fixed-effect).
        2. Computes the **indirect** estimate as the network estimate
           minus the direct contribution.
        3. Tests the difference with
           ``z = (direct - indirect) / sqrt(var_direct + var_indirect)``.

        Returns
        -------
        dict[str, dict[str, float]]
            Keyed by ``"A vs B"`` with sub-keys ``direct``, ``indirect``,
            ``difference``, ``se``, ``p_value``.
        """
        self._ensure_fitted()

        direct_map: dict[tuple[str, str], list[int]] = defaultdict(list)
        for index, c in enumerate(self.contrasts):
            pair = tuple(sorted([c["treatment"], c["comparator"]]))
            direct_map[pair].append(index)

        results: dict[str, dict[str, float]] = {}

        for (trt_a, trt_b), direct_indices in direct_map.items():
            indirect_contrasts = [
                contrast
                for index, contrast in enumerate(self.contrasts)
                if index not in set(direct_indices)
            ]
            if not indirect_contrasts:
                continue
            try:
                indirect_engine = NMAEngine(
                    indirect_contrasts,
                    self.treatments,
                    reference=self.reference,
                    outcome_direction=self.outcome_direction,
                )
                if not indirect_engine.network_geometry()["is_connected"]:
                    continue
                indirect_engine.fit()
                indirect_effect, indirect_var = indirect_engine._pairwise_estimate(trt_a, trt_b)
            except (ValueError, np.linalg.LinAlgError, MultiArmCovarianceError):
                continue

            direct_rows = [self.contrasts[index] for index in direct_indices]
            y_direct = np.array([float(row["yi"]) for row in direct_rows], dtype=float)
            signs = []
            for c in direct_rows:
                if c["treatment"] == trt_a and c["comparator"] == trt_b:
                    signs.append(1.0)
                else:
                    signs.append(-1.0)
            orientation = np.array(signs, dtype=float)
            covariance = self._V[np.ix_(direct_indices, direct_indices)]
            oriented_covariance = covariance * np.outer(orientation, orientation)
            precision = np.linalg.inv(oriented_covariance)
            ones = np.ones(len(direct_indices), dtype=float)
            oriented_y = y_direct * orientation
            denominator = float(ones @ precision @ ones)
            direct_effect = float(ones @ precision @ oriented_y / denominator)
            direct_var = float(1.0 / denominator)

            # -- Inconsistency test --
            diff = direct_effect - indirect_effect
            se_diff = np.sqrt(direct_var + indirect_var)
            z = diff / se_diff if se_diff > 0 else 0.0
            p_value = float(2 * (1 - stats.norm.cdf(abs(z))))

            label = f"{trt_a} vs {trt_b}"
            results[label] = {
                "direct": round(float(direct_effect), 6),
                "indirect": round(float(indirect_effect), 6),
                "difference": round(float(diff), 6),
                "se": round(float(se_diff), 6),
                "p_value": round(p_value, 6),
                "direct_studies": len({row.get("study_id") for row in direct_rows}),
                "indirect_contrasts": len(indirect_contrasts),
                "method": "separate_indirect_network",
            }

        return results

    # -----------------------------------------------------------------
    # Network geometry
    # -----------------------------------------------------------------

    def network_geometry(self) -> dict[str, Any]:
        """Characterise the network geometry.

        Returns
        -------
        dict
            - ``nodes`` : list of ``{treatment, n_studies}`` dicts
            - ``edges`` : list of ``{treatment, comparator, n_studies}``
            - ``is_connected`` : whether the network graph is connected
        """
        # Count how many studies involve each treatment
        trt_studies: dict[str, set[str]] = defaultdict(set)
        edge_count: dict[tuple[str, str], set[str]] = defaultdict(set)

        for c in self.contrasts:
            sid = c.get("study_id", "")
            trt_studies[c["treatment"]].add(sid)
            trt_studies[c["comparator"]].add(sid)
            pair = tuple(sorted([c["treatment"], c["comparator"]]))
            edge_count[pair].add(sid)

        nodes = [
            {"treatment": t, "n_studies": len(trt_studies.get(t, set()))}
            for t in self.treatments
        ]

        edges = [
            {
                "treatment": pair[0],
                "comparator": pair[1],
                "n_studies": len(sids),
            }
            for pair, sids in sorted(edge_count.items())
        ]

        is_connected = self._check_connected(edge_count)

        return {
            "nodes": nodes,
            "edges": edges,
            "is_connected": is_connected,
        }

    def _check_connected(
        self,
        edge_count: dict[tuple[str, str], set[str]],
    ) -> bool:
        """BFS to verify the treatment network is fully connected."""
        if len(self.treatments) <= 1:
            return True

        adjacency: dict[str, set[str]] = defaultdict(set)
        for (a, b) in edge_count:
            adjacency[a].add(b)
            adjacency[b].add(a)

        visited: set[str] = set()
        queue = [self.treatments[0]]
        visited.add(self.treatments[0])

        while queue:
            node = queue.pop(0)
            for neighbour in adjacency[node]:
                if neighbour not in visited:
                    visited.add(neighbour)
                    queue.append(neighbour)

        return visited >= set(self.treatments)

    # -----------------------------------------------------------------
    # Global inconsistency (generalised Q)
    # -----------------------------------------------------------------

    def _global_inconsistency_test(self) -> float | None:
        """Generalised Cochran Q test for network inconsistency.

        Q = (y - X beta)' W (y - X beta)

        Under consistency, Q ~ chi^2(m - p) where m = number of contrasts
        and p = number of basic parameters.

        Returns the p-value, or ``None`` when degrees of freedom < 1.
        """
        if not self._fitted:
            return None

        X, W, y = self._X, self._W, self._y
        beta = self._beta

        residuals = y - X @ beta
        Q = float(residuals @ W @ residuals)
        df = len(y) - self._n_params

        if df < 1:
            return None

        p_value = float(1.0 - stats.chi2.cdf(Q, df))
        return round(p_value, 6)

    def _design_by_treatment_inconsistency(self) -> dict[str, Any]:
        """Compare the consistency model with design-specific treatment effects.

        The expanded model has separate basic effects within each observed
        treatment design. The reduction in weighted residual Q relative to the
        consistency model is the design-by-treatment interaction statistic.
        """
        if not self._fitted:
            return {
                "method": "design_by_treatment_interaction",
                "q_inconsistency": None,
                "df": 0,
                "p_value": None,
            }
        study_treatments: dict[str, set[str]] = defaultdict(set)
        for study_id, contrast in zip(self._study_ids, self.contrasts):
            study_treatments[str(study_id)].update(
                [str(contrast["treatment"]), str(contrast["comparator"])]
            )
        study_design = {
            study_id: tuple(sorted(treatments))
            for study_id, treatments in study_treatments.items()
        }
        columns: list[tuple[tuple[str, ...], str]] = []
        for design in sorted(set(study_design.values())):
            baseline = design[0]
            columns.extend((design, treatment) for treatment in design if treatment != baseline)
        column_index = {column: index for index, column in enumerate(columns)}
        Z = np.zeros((len(self.contrasts), len(columns)), dtype=float)
        for row_index, (study_id, contrast) in enumerate(zip(self._study_ids, self.contrasts)):
            design = study_design[str(study_id)]
            baseline = design[0]
            treatment = str(contrast["treatment"])
            comparator = str(contrast["comparator"])
            if treatment != baseline:
                Z[row_index, column_index[(design, treatment)]] += 1.0
            if comparator != baseline:
                Z[row_index, column_index[(design, comparator)]] -= 1.0
        weight = getattr(self, "_W_original", self._W)
        rank_consistency = int(np.linalg.matrix_rank(self._X))
        rank_design = int(np.linalg.matrix_rank(Z))
        df = rank_design - rank_consistency
        consistency_info = self._X.T @ weight @ self._X
        consistency_beta = np.linalg.pinv(consistency_info) @ self._X.T @ weight @ self._y
        consistency_residuals = self._y - self._X @ consistency_beta
        q_consistency = float(consistency_residuals @ weight @ consistency_residuals)
        try:
            info = Z.T @ weight @ Z
            beta_design = np.linalg.pinv(info) @ Z.T @ weight @ self._y
            design_residuals = self._y - Z @ beta_design
            q_design = float(design_residuals @ weight @ design_residuals)
        except np.linalg.LinAlgError:
            q_design = math.nan
        q_inconsistency = max(0.0, q_consistency - q_design) if math.isfinite(q_design) else math.nan
        p_value = (
            float(stats.chi2.sf(q_inconsistency, df))
            if df > 0 and math.isfinite(q_inconsistency)
            else None
        )
        return {
            "method": "design_by_treatment_interaction",
            "q_consistency": q_consistency,
            "q_design_specific": q_design,
            "q_inconsistency": q_inconsistency,
            "df": df,
            "p_value": p_value,
            "n_designs": len(set(study_design.values())),
        }

    def _fit_diagnostics(self) -> dict[str, Any]:
        residuals = self._y - self._X @ self._beta
        q = float(residuals @ self._W @ residuals)
        df = len(self._y) - self._n_params
        grouped: dict[str, int] = defaultdict(int)
        for study_id in self._study_ids:
            grouped[str(study_id)] += 1
        return {
            "global_q": q,
            "global_q_df": df,
            "global_q_p": (
                float(1 - stats.chi2.cdf(q, df)) if df > 0 else None
            ),
            "multiarm_covariance": any(count > 1 for count in grouped.values()),
            "global_q_interpretation": (
                "residual heterogeneity and inconsistency are not separable without a design-by-treatment model"
            ),
        }

    # -----------------------------------------------------------------
    # Helpers
    # -----------------------------------------------------------------

    def _ensure_fitted(self) -> None:
        """Raise if the model has not been fitted yet."""
        if not self._fitted:
            raise RuntimeError(
                "Model has not been fitted. Call .fit() before requesting "
                "results."
            )

    # -----------------------------------------------------------------
    # Random-Effects NMA (DerSimonian-Laird heterogeneity)
    # -----------------------------------------------------------------

    def fit_random_effects(self) -> NMAResult:
        """Fit a random-effects NMA model.

        Estimates a common heterogeneity variance by restricted maximum
        likelihood and preserves the required tau²/2 covariance between
        dependent contrasts from the same multi-arm study.

        Returns
        -------
        NMAResult
            Same structure as fixed-effect fit, but with random-effects weights.
        """
        X, y = self._X, self._y

        def restricted_negative_log_likelihood(tau2: float) -> float:
            try:
                covariance = self._random_effect_covariance(float(tau2))
                precision = np.linalg.inv(covariance)
                information = X.T @ precision @ X
                var_beta = np.linalg.inv(information)
                beta = var_beta @ X.T @ precision @ y
                residuals = y - X @ beta
                sign_cov, logdet_cov = np.linalg.slogdet(covariance)
                sign_info, logdet_info = np.linalg.slogdet(information)
                if sign_cov <= 0 or sign_info <= 0:
                    return math.inf
                return 0.5 * (
                    logdet_cov
                    + logdet_info
                    + float(residuals.T @ precision @ residuals)
                )
            except np.linalg.LinAlgError:
                return math.inf

        df = len(y) - self._n_params
        if df <= 0:
            tau2 = 0.0
        else:
            upper = max(float(np.var(y, ddof=1) * 10), float(np.max(np.diag(self._V))), 1.0)
            optimum = optimize.minimize_scalar(
                restricted_negative_log_likelihood,
                bounds=(0.0, upper),
                method="bounded",
                options={"xatol": 1e-10, "maxiter": 1000},
            )
            tau2 = max(0.0, float(optimum.x)) if optimum.success else 0.0

        covariance_re = self._random_effect_covariance(tau2)
        W_re = np.linalg.inv(covariance_re)
        information_re = X.T @ W_re @ X
        try:
            var_beta_re = np.linalg.inv(information_re)
        except np.linalg.LinAlgError as exc:
            raise np.linalg.LinAlgError(
                "Random-effects NMA information matrix is singular; network may be disconnected."
            ) from exc
        beta_re = var_beta_re @ X.T @ W_re @ y

        self._beta = beta_re
        self._var_beta = var_beta_re
        self._W_original = self._W
        self._W = W_re  # Use RE weights for league table etc.
        self._fitted = True
        self._tau_squared = tau2

        # Assemble result
        lt = self.league_table()
        sucra_scores = self.sucra()
        geometry = self.network_geometry()
        design_by_treatment = self._design_by_treatment_inconsistency()
        inconsistency_p = design_by_treatment.get("p_value")

        result = NMAResult(
            treatments=self.treatments,
            reference=self.reference,
            model="random",
            tau_squared=tau2,
            tau_estimator="REML",
            ranking_direction=self.outcome_direction,
            league_table=lt,
            sucra_rankings=sucra_scores,
            inconsistency_p=inconsistency_p,
            network_geometry=geometry,
            diagnostics={
                **self._fit_diagnostics(),
                "design_by_treatment": design_by_treatment,
                "reml_objective": restricted_negative_log_likelihood(tau2),
            },
        )
        return result


_NMA_RATIO_MEASURES = {"OR", "RR", "HR"}
_NMA_Z_975 = 1.959963984540054


class NetworkMetaRecord(BaseModel):
    result_id: str = Field(min_length=1)
    study_id: str = Field(min_length=1)
    design: str = Field(min_length=1)
    measure: str = Field(min_length=1)
    estimate: float
    standard_error: float | None = Field(default=None, gt=0)
    variance: float | None = Field(default=None, gt=0)
    ci_lower: float | None = None
    ci_upper: float | None = None
    scale: str = "original"
    precision_basis: str = Field(min_length=1)
    estimand_id: str = Field(min_length=1)
    treatment: str = Field(min_length=1)
    comparator: str = Field(min_length=1)
    contrast_id: str = Field(min_length=1)
    covariance_with: dict[str, float] = Field(default_factory=dict)
    intracluster_correlation: float | None = Field(default=None, ge=0, lt=1)
    mean_cluster_size: float | None = Field(default=None, gt=1)

    @model_validator(mode="after")
    def validate_precision(self):
        if self.standard_error is None and self.variance is None and (
            self.ci_lower is None or self.ci_upper is None
        ):
            raise ValueError("network contrast requires SE, variance, or confidence interval")
        if self.design not in {"parallel_rct", "multi_arm_rct", "cluster_rct"}:
            raise ValueError(f"unsupported network design: {self.design}")
        return self


class TransitivityAssessment(BaseModel):
    status: str = Field(pattern="^(adequate|uncertain|concern)$")
    effect_modifiers: list[str] = Field(min_length=1)
    rationale: str = Field(min_length=10)


class NetworkMetaResult(BaseModel):
    schema_version: int = 1
    estimator: str = "CONTRAST_BASED_NMA_REML"
    measure: str
    n_studies: int
    n_contrasts: int
    treatments: list[str]
    reference: str
    model: str
    tau_squared: float = Field(ge=0)
    league_table: list[dict[str, Any]]
    rankings: dict[str, float]
    node_splitting: dict[str, dict[str, Any]]
    transitivity_assessment: dict[str, Any]
    network_geometry: dict[str, Any]
    inconsistency_p: float | None = None
    converged: bool = True
    diagnostics: dict[str, Any] = Field(default_factory=dict)


def run_network_meta(
    records: list[NetworkMetaRecord | dict],
    *,
    reference: str | None = None,
    outcome_direction: str = "lower",
    transitivity_assessment: TransitivityAssessment | dict | None = None,
) -> NetworkMetaResult:
    """Run a production contrast-based random-effects network meta-analysis."""
    if transitivity_assessment is None:
        raise ValueError(
            "a transitivity assessment of prespecified effect modifiers is required before NMA"
        )
    transitivity = (
        transitivity_assessment
        if isinstance(transitivity_assessment, TransitivityAssessment)
        else TransitivityAssessment.model_validate(transitivity_assessment)
    )
    if transitivity.status != "adequate":
        raise ValueError(
            "transitivity was not established; revise the network or adjudicate the effect-modifier assessment"
        )
    rows = [
        item if isinstance(item, NetworkMetaRecord) else NetworkMetaRecord.model_validate(item)
        for item in records
    ]
    if len(rows) < 3:
        raise ValueError("network meta-analysis requires at least three contrasts")
    measures = {item.measure.upper() for item in rows}
    if len(measures) != 1:
        raise ValueError("all network contrasts must use one effect measure")
    estimands = {_nma_norm(item.estimand_id) for item in rows}
    if len(estimands) != 1:
        raise ValueError("all network contrasts must use one outcome estimand")
    measure = next(iter(measures))
    contrasts = []
    for row in rows:
        yi, vi = _network_analysis_effect(row, measure)
        if row.design == "cluster_rct":
            if row.precision_basis == "reported_cluster_adjusted":
                pass
            elif row.precision_basis == "design_effect_adjusted":
                if row.intracluster_correlation is None or row.mean_cluster_size is None:
                    raise ValueError(
                        "cluster network contrast requires adjusted precision or ICC and mean cluster size"
                    )
                vi *= 1.0 + (row.mean_cluster_size - 1.0) * row.intracluster_correlation
            else:
                raise ValueError("cluster network contrast requires cluster-adjusted precision")
        contrasts.append({
            "study_id": row.study_id,
            "contrast_id": row.contrast_id,
            "treatment": row.treatment,
            "comparator": row.comparator,
            "yi": yi,
            "vi": vi,
            "covariance_with": row.covariance_with,
        })
    treatments = sorted({
        name for row in rows for name in (row.treatment, row.comparator)
    })
    if len(treatments) < 3:
        raise ValueError("network meta-analysis requires at least three treatments")
    chosen_reference = reference or _network_reference(rows)
    if chosen_reference not in treatments:
        raise ValueError("requested NMA reference is absent from the treatment network")
    engine = NMAEngine(
        contrasts,
        treatments,
        reference=chosen_reference,
        outcome_direction=outcome_direction,
    )
    if not engine.network_geometry()["is_connected"]:
        raise ValueError("treatment network is disconnected")
    fitted = engine.fit_random_effects()
    league = []
    for item in fitted.league_table:
        if measure in _NMA_RATIO_MEASURES:
            effect, lower, upper = math.exp(item.effect), math.exp(item.ci_lower), math.exp(item.ci_upper)
        else:
            effect, lower, upper = item.effect, item.ci_lower, item.ci_upper
        league.append({
            "treatment": item.treatment,
            "comparator": item.comparator,
            "effect": float(effect),
            "ci_lower": float(lower),
            "ci_upper": float(upper),
            "p_value": item.p_value,
        })
    diagnostics = dict(fitted.diagnostics)
    diagnostics.update({
        "analysis_scale": "log" if measure in _NMA_RATIO_MEASURES else "original",
        "transitivity_status": transitivity.status,
        "outcome_direction": outcome_direction,
    })
    return NetworkMetaResult(
        measure=measure,
        n_studies=len({item.study_id for item in rows}),
        n_contrasts=len(rows),
        treatments=treatments,
        reference=chosen_reference,
        model=fitted.model,
        tau_squared=fitted.tau_squared,
        league_table=league,
        rankings=fitted.sucra_rankings,
        node_splitting=engine.node_splitting(),
        transitivity_assessment=transitivity.model_dump(mode="json"),
        network_geometry=fitted.network_geometry,
        inconsistency_p=fitted.inconsistency_p,
        diagnostics=diagnostics,
    )


def _network_analysis_effect(record: NetworkMetaRecord, measure: str) -> tuple[float, float]:
    ratio = measure in _NMA_RATIO_MEASURES
    estimate = float(record.estimate)
    lower, upper = record.ci_lower, record.ci_upper
    if ratio and record.scale.strip().lower() == "original":
        if estimate <= 0 or (lower is not None and lower <= 0) or (upper is not None and upper <= 0):
            raise ValueError(f"{measure} network effects and confidence bounds must be positive")
        yi = math.log(estimate)
        ci_se = (
            (math.log(float(upper)) - math.log(float(lower))) / (2 * _NMA_Z_975)
            if lower is not None and upper is not None
            else None
        )
    else:
        yi = estimate
        ci_se = (
            (float(upper) - float(lower)) / (2 * _NMA_Z_975)
            if lower is not None and upper is not None
            else None
        )
    if ci_se is not None:
        vi = ci_se * ci_se
    elif record.standard_error is not None:
        vi = float(record.standard_error) ** 2
    else:
        vi = float(record.variance)
    if not math.isfinite(yi) or not math.isfinite(vi) or vi <= 0:
        raise ValueError("network effect and precision must be finite with positive variance")
    return yi, vi


def _network_reference(rows: list[NetworkMetaRecord]) -> str:
    counts: dict[str, int] = defaultdict(int)
    for row in rows:
        counts[row.treatment] += 1
        counts[row.comparator] += 1
    return sorted(counts, key=lambda value: (-counts[value], value))[0]


def _nma_norm(value: str) -> str:
    return " ".join(str(value).strip().casefold().replace("_", " ").split())
