# [IN] models.py
# [OUT] ColumnMapping presets and auto-detection
# [POS] mr_agent/tools/column_presets.py - Column mapping presets
"""Column mapping presets for common GWAS data formats."""

from __future__ import annotations

from mr_agent.models import ColumnMapping, ColumnPreset

PRESETS: dict[ColumnPreset, ColumnMapping] = {
    ColumnPreset.TWOSAMPLEMR: ColumnMapping(
        snp="SNP", beta="beta", se="se",
        effect_allele="effect_allele", other_allele="other_allele",
        eaf="eaf", pval="pval",
    ),
    ColumnPreset.EQTLGEN: ColumnMapping(
        snp="SNP", beta="beta", se="se",
        effect_allele="AssessedAllele", other_allele="OtherAllele",
        eaf="", pval="Pvalue",
        gene="Gene", z_score_column="Zscore",
    ),
    ColumnPreset.GTEX: ColumnMapping(
        snp="variant_id", beta="slope", se="slope_se",
        effect_allele="alt", other_allele="ref",
        eaf="maf", pval="pval_nominal",
        gene="gene_id",
    ),
    ColumnPreset.FINNGEN: ColumnMapping(
        snp="rsids", beta="beta", se="sebeta",
        effect_allele="alt", other_allele="ref",
        eaf="af_alt", pval="pval",
        chr="chrom", pos="pos",
    ),
    ColumnPreset.UKB_PPP: ColumnMapping(
        snp="ID", beta="BETA", se="SE",
        effect_allele="ALLELE1", other_allele="ALLELE0",
        eaf="A1FREQ", pval="P",
        chr="CHROM", pos="GENPOS", log10p="LOG10P",
    ),
    ColumnPreset.GWAS_CATALOG: ColumnMapping(
        snp="variant_id", beta="beta", se="standard_error",
        effect_allele="effect_allele", other_allele="other_allele",
        eaf="effect_allele_frequency", pval="p_value",
        chr="chromosome", pos="base_pair_location",
    ),
}

# Column signatures for auto-detection (unique columns per format)
_DETECTION_SIGNATURES: list[tuple[ColumnPreset, set[str]]] = [
    (ColumnPreset.EQTLGEN, {"AssessedAllele", "OtherAllele", "Zscore"}),
    (ColumnPreset.GTEX, {"variant_id", "slope", "slope_se", "pval_nominal"}),
    (ColumnPreset.FINNGEN, {"rsids", "sebeta", "af_alt"}),
    (ColumnPreset.UKB_PPP, {"ALLELE0", "ALLELE1", "A1FREQ", "LOG10P"}),
    (ColumnPreset.GWAS_CATALOG, {"variant_id", "standard_error", "base_pair_location"}),
    (ColumnPreset.TWOSAMPLEMR, {"SNP", "beta", "se", "effect_allele", "pval"}),
]


def get_preset(preset: ColumnPreset) -> ColumnMapping:
    """Return the column mapping for a given preset."""
    return PRESETS[preset].model_copy()


def detect_preset(columns: list[str]) -> ColumnPreset | None:
    """Auto-detect data format from column headers.

    Returns the matching ColumnPreset or None if no match found.
    """
    col_set = set(columns)
    for preset, signature in _DETECTION_SIGNATURES:
        if signature.issubset(col_set):
            return preset
    return None
