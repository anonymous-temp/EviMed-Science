"""
阿里云 OSS 上传工具
将报告文件上传至 OSS，返回可公开访问的 URL。

路径规则：
  {agentType}/{userId}/{messageId}/{timestamp_ms}.md
示例：
  research-topic-selection/5773064745007488920/4cc00a48-9abf-48ee-abea-df362c524728/1772700275927.md
"""
import os
import time
import tempfile
import asyncio
import logging
from typing import Optional

logger = logging.getLogger(__name__)


def _upload_to_oss(content: str, remote_path: str) -> None:
    """同步上传字符串内容到 OSS（在线程中执行，不阻塞事件循环）"""
    import oss2
    from config.settings import settings

    auth = oss2.Auth(settings.OSS_ACCESS_KEY_ID, settings.OSS_ACCESS_KEY_SECRET)
    bucket = oss2.Bucket(auth, settings.OSS_ENDPOINT, settings.OSS_BUCKET_NAME)

    # 写临时文件后上传
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".md", encoding="utf-8", delete=False
    ) as f:
        f.write(content)
        tmp_path = f.name

    try:
        for attempt in range(3):
            try:
                bucket.put_object_from_file(remote_path, tmp_path)
                logger.info(f"OSS 上传成功: {remote_path}")
                return
            except Exception as e:
                logger.warning(f"OSS 上传失败(attempt {attempt + 1}): {e}")
                if attempt < 2:
                    time.sleep(2)
        raise RuntimeError(f"OSS 上传失败，已重试 3 次: {remote_path}")
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass


async def upload_report(
    content: str,
    user_id: str,
    message_id: str,
    agent_type: str = "research-topic-selection",
) -> Optional[str]:
    """
    异步上传报告到 OSS。

    Args:
        content:    报告 Markdown 内容
        user_id:    用户 ID（来自 Java 消息的 userId 字段）
        message_id: 本次消息 UUID（用于子目录，保证唯一）
        agent_type: 顶层目录名，默认 "research-topic-selection"

    Returns:
        公开访问 URL，上传失败时返回 None
    """
    from config.settings import settings

    if not settings.OSS_ACCESS_KEY_ID or not settings.OSS_ACCESS_KEY_SECRET:
        logger.warning("OSS 凭证未配置，跳过上传")
        return None

    timestamp_ms = int(time.time() * 1000)
    remote_path = f"{agent_type}/{user_id}/{message_id}/{timestamp_ms}.md"

    try:
        await asyncio.to_thread(_upload_to_oss, content, remote_path)
        url = f"{settings.OSS_PUBLIC_BASE_URL.rstrip('/')}/{remote_path}"
        return url
    except Exception as e:
        logger.error(f"OSS 上传异常，降级为 base64 返回: {e}")
        return None
