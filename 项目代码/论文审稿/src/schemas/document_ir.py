"""
DocumentIR: Structured intermediate representation of manuscript
"""
from typing import Optional, List, Dict, Any, Tuple
from pydantic import BaseModel, Field


class ParagraphIndex(BaseModel):
    """Index for a single paragraph with location information"""
    paragraph_id: str = Field(..., description="Unique identifier for this paragraph")
    text: str = Field(..., description="The paragraph text content")
    page: Optional[int] = Field(default=None, description="Page number (if available)")
    offset: int = Field(..., description="Character offset from document start")
    section: str = Field(..., description="Section this paragraph belongs to")

    class Config:
        json_schema_extra = {
            "example": {
                "paragraph_id": "para_001",
                "text": "Patients were randomized using computer-generated random numbers.",
                "page": 5,
                "offset": 1234,
                "section": "methods.randomization"
            }
        }


class SectionIndex(BaseModel):
    """Index for a document section with span information"""
    section_name: str = Field(..., description="Hierarchical section name (e.g., 'methods.randomization')")
    span: Tuple[int, int] = Field(..., description="Character span (start, end) in full text")
    page_start: Optional[int] = Field(default=None, description="Starting page number")
    page_end: Optional[int] = Field(default=None, description="Ending page number")
    paragraph_ids: List[str] = Field(default_factory=list, description="IDs of paragraphs in this section")

    class Config:
        json_schema_extra = {
            "example": {
                "section_name": "methods.randomization",
                "span": (1200, 1500),
                "page_start": 5,
                "page_end": 5,
                "paragraph_ids": ["para_001", "para_002"]
            }
        }


class SectionText(BaseModel):
    """Structured text with paragraph-level indexing"""
    text: List[str] = Field(default_factory=list, description="List of paragraphs")

    def __getitem__(self, index: int) -> str:
        """Allow indexing like section_text[0]"""
        return self.text[index] if index < len(self.text) else ""


class MethodsSection(BaseModel):
    """Methods section structured data"""
    study_design: SectionText = Field(default_factory=SectionText)
    participants: SectionText = Field(default_factory=SectionText)
    eligibility: SectionText = Field(default_factory=SectionText)
    randomization: SectionText = Field(default_factory=SectionText)
    blinding: SectionText = Field(default_factory=SectionText)
    interventions: SectionText = Field(default_factory=SectionText)
    outcomes: SectionText = Field(default_factory=SectionText)
    sample_size: SectionText = Field(default_factory=SectionText)
    statistics: SectionText = Field(default_factory=SectionText)
    ethics: SectionText = Field(default_factory=SectionText)
    model_development: SectionText = Field(default_factory=SectionText)
    model_validation: SectionText = Field(default_factory=SectionText)
    full_text: SectionText = Field(default_factory=SectionText)


class ResultsSection(BaseModel):
    """Results section structured data"""
    participant_flow: SectionText = Field(default_factory=SectionText)
    baseline: SectionText = Field(default_factory=SectionText)
    outcomes: SectionText = Field(default_factory=SectionText)
    adverse_events: SectionText = Field(default_factory=SectionText)
    full_text: SectionText = Field(default_factory=SectionText)


class DiscussionSection(BaseModel):
    """Discussion section structured data"""
    limitations: SectionText = Field(default_factory=SectionText)
    generalizability: SectionText = Field(default_factory=SectionText)
    interpretation: SectionText = Field(default_factory=SectionText)
    full_text: SectionText = Field(default_factory=SectionText)


class TableData(BaseModel):
    """Structured table representation"""
    table_number: int
    caption: str = ""
    headers: List[str] = Field(default_factory=list)
    rows: List[List[str]] = Field(default_factory=list)

    def cell(self, row: int, col: int) -> str:
        """Get cell value at position"""
        if row < len(self.rows) and col < len(self.rows[row]):
            return self.rows[row][col]
        return ""


class FigureData(BaseModel):
    """Structured figure representation"""
    figure_number: int
    caption: str = ""
    description: str = ""


class DocumentIR(BaseModel):
    """
    Structured intermediate representation of the entire manuscript.
    This is the core data structure consumed by all downstream agents.
    """
    # Basic metadata
    title: str = ""
    abstract: SectionText = Field(default_factory=SectionText)
    keywords: List[str] = Field(default_factory=list)

    # Main sections
    introduction: SectionText = Field(default_factory=SectionText)
    methods: MethodsSection = Field(default_factory=MethodsSection)
    results: ResultsSection = Field(default_factory=ResultsSection)
    discussion: DiscussionSection = Field(default_factory=DiscussionSection)
    conclusion: SectionText = Field(default_factory=SectionText)

    # Supporting sections
    references: List[str] = Field(default_factory=list)
    appendices: Dict[str, SectionText] = Field(default_factory=dict)

    # Structured data
    tables: List[TableData] = Field(default_factory=list)
    figures: List[FigureData] = Field(default_factory=list)

    # Extracted key information
    extracted_info: Dict[str, Any] = Field(
        default_factory=dict,
        description="Key structured information extracted from the manuscript"
    )

    # Detected language of the manuscript
    language: str = Field(
        default="en",
        description="Detected manuscript language: 'zh' for Chinese, 'en' for English"
    )

    # NEW: Full-text and indexing structures
    fulltext: str = Field(
        default="",
        description="Complete manuscript text for full-text search"
    )
    paragraphs: List[ParagraphIndex] = Field(
        default_factory=list,
        description="Indexed paragraphs with location information"
    )
    section_index: List[SectionIndex] = Field(
        default_factory=list,
        description="Index of all sections with span information"
    )

    class Config:
        json_schema_extra = {
            "example": {
                "title": "A Randomized Controlled Trial of...",
                "abstract": {"text": ["Background: ...", "Methods: ...", "Results: ..."]},
                "methods": {
                    "randomization": {"text": ["Patients were randomized using..."]}
                }
            }
        }


class EvidenceMap(BaseModel):
    """
    Index mapping from medical terms/concepts to their locations in DocumentIR.
    Used to accelerate evidence retrieval by reviewer agents.
    """
    term_locations: Dict[str, List[str]] = Field(
        default_factory=dict,
        description="Mapping from term to DocumentIR path locations"
    )

    def get_locations(self, term: str) -> List[str]:
        """Get all locations where a term appears"""
        return self.term_locations.get(term.lower(), [])

    class Config:
        json_schema_extra = {
            "example": {
                "term_locations": {
                    "p-value": ["results.full_text[3]", "tables[1].cell[2,3]"],
                    "confidence interval": ["results.full_text[3]", "results.full_text[5]"],
                    "random forest": ["methods.statistics.text[2]"],
                    "informed consent": ["methods.ethics.text[1]"]
                }
            }
        }


class StudyProfile(BaseModel):
    """
    Study classification and metadata extracted from the manuscript.
    Used by Rubric Orchestrator to determine which checklists to apply.
    """
    study_types: List[str] = Field(
        default_factory=list,
        description="Multi-label classification of study methodology types"
    )
    metadata: Dict[str, Any] = Field(
        default_factory=dict,
        description="Key metadata about the study"
    )

    class Config:
        json_schema_extra = {
            "example": {
                "study_types": ["RCT", "Prognostic Model", "AI"],
                "metadata": {
                    "primary_outcome": "Sepsis detection rate at 24h",
                    "sample_size": "350 patients",
                    "model_type": "Logistic Regression",
                    "study_phase": "Phase 3",
                    "registration_id": "NCT12345678"
                }
            }
        }


# List of all recognized study types
RECOGNIZED_STUDY_TYPES = [
    # 随机对照试验
    "RCT",
    "Cluster RCT",
    "Pragmatic RCT",
    "Non-Inferiority RCT",
    # 综述类
    "Systematic Review",
    "Meta-Analysis",
    "Network Meta-Analysis",
    "IPD Meta-Analysis",
    "Scoping Review",
    "Narrative Review",
    "Literature Review",
    "Umbrella Review",
    "Rapid Review",
    # 观察性研究
    "Observational Study",
    "Cohort Study",
    "Case-Control Study",
    "Cross-Sectional Study",
    "Real World Data Study",
    # 诊断/预测
    "Diagnostic Study",
    "Prognostic Model",
    "Prediction Model",
    # AI/ML
    "AI",
    "Machine Learning",
    # 卫生经济
    "Economic Evaluation",
    "Cost-Effectiveness Analysis",
    "Budget Impact Analysis",
    # 指南/共识
    "Clinical Practice Guideline",
    "Expert Consensus",
    "Protocol",
    "Protocol for Clinical Practice Guideline",
    "Guideline Development",
    # 病例/定性/动物
    "Case Report",
    "Qualitative Research",
    "Implementation Science",
    "Animal Study",
    "Instrument Development",
    "Mixed Methods",
    # 文献计量/横断面分析（非综述）——关键新增类型
    "Bibliometric Study",
    "Bibliometric Analysis",
    "Cross-Sectional Analysis",
    "Literature Analysis",
    "Systematic Analysis",
    "Descriptive Study",
    # 方法学/框架/基准
    "Methodology Paper",
    "Framework Paper",
    "Benchmark Paper",
    # 质量改进
    "Quality Improvement",
    # 组学/基因组学
    "Genomics Study",
    "Transcriptomics Study",
    "Sequencing Study",
    "Proteomics Study",
    "Multi-Omics Study",
    # 神经影像
    "Neuroimaging Study",
    "fMRI Study",
    "MRI Study",
    "Diffusion MRI Study",
    "PET Study",
    # 流式细胞
    "Flow Cytometry Study",
    "Mass Cytometry Study",
]
