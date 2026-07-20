"""
分析模块包 - M1-M11（已移除M12方法学声明模块）
"""
# from modules.new_analysis_modules import (
#     BaseAnalysisModule,
#     M1_BackgroundModule,
#     M2_BibliometricsModule,
#     M3_EvidenceDiagnosisModule,
#     M4_EvidenceMapModule,
#     M5_GapsModule,
#     M6_UncertaintyModule,
#     M7_TrendsModule,
#     M10_StrategyModule,
#     M11_TopicsModule
# )
#
# __all__ = [
#     "BaseAnalysisModule",
#     "M1_BackgroundModule",
#     "M2_BibliometricsModule",
#     "M3_EvidenceDiagnosisModule",
#     "M4_EvidenceMapModule",
#     "M5_GapsModule",
#     "M6_UncertaintyModule",
#     "M7_TrendsModule",
#     "M10_StrategyModule",
#     "M11_TopicsModule"
# ]


from modules.new_analysis_modules import (
    BaseAnalysisModule,
    M1_ProblemLandscapeModule,
    M2_ResearchEcosystemModule,
    M3_EvidenceSystemModule,
    M4_ScientificContradictionModule,
    M5_BreakthroughOpportunityModule,
    M6_ResearchAgendaModule,
)

__all__ = [
    "BaseAnalysisModule",
    "M1_ProblemLandscapeModule",
    "M2_ResearchEcosystemModule",
    "M3_EvidenceSystemModule",
    "M4_ScientificContradictionModule",
    "M5_BreakthroughOpportunityModule",
    "M6_ResearchAgendaModule",
]
