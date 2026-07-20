"""
API endpoint for V2 multi-rubric architecture
"""
from fastapi import APIRouter, File, UploadFile, HTTPException
from pydantic import BaseModel
from typing import Optional
import tempfile
import os
import asyncio

from ..main_v2 import ReviewOrchestratorV2
from ..schemas.meta_review import MultiRubricReviewResult

router = APIRouter(tags=["review-v2"])

# 并发控制：最多同时处理的审稿任务
_REVIEW_SEMAPHORE = asyncio.Semaphore(int(os.getenv("MAX_CONCURRENT_REVIEWS_V2", "3")))


class ReviewResponseV2(BaseModel):
    """V2 审稿响应"""
    job_id: str
    title: str
    rubrics_used: list
    recommendation: str
    overall_evaluation: str
    key_strengths: str
    critical_issues: str
    minor_suggestions: str
    recommendation_detail: str
    processing_time: float
    fatal_issues_count: int
    major_issues_count: int


@router.post("/review", response_model=ReviewResponseV2)
async def review_manuscript_v2(file: UploadFile = File(...)):
    """V2 多规范并行审稿接口（默认）"""

    tmp_path = None

    try:
        # 保存上传文件
        with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
            content = await file.read()
            tmp.write(content)
            tmp_path = tmp.name

        # 并发控制
        async with _REVIEW_SEMAPHORE:
            # 执行审稿
            orchestrator = ReviewOrchestratorV2()
            result = await orchestrator.review_manuscript(tmp_path)

        # 构建响应
        return ReviewResponseV2(
            job_id=result.narrative_report.generated_at.isoformat(),
            title=result.document_title,
            rubrics_used=result.rubrics_used,
            recommendation=result.meta_review.recommendation,
            overall_evaluation=result.narrative_report.overall_evaluation,
            key_strengths=result.narrative_report.key_strengths_narrative,
            critical_issues=result.narrative_report.critical_issues_narrative,
            minor_suggestions=result.narrative_report.minor_suggestions_narrative,
            recommendation_detail=result.narrative_report.recommendation_narrative,
            processing_time=result.processing_time,
            fatal_issues_count=len(result.meta_review.fatal_issues),
            major_issues_count=len(result.meta_review.major_issues)
        )

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"审稿失败: {str(e)}")

    finally:
        # 清理临时文件
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except:
                pass
