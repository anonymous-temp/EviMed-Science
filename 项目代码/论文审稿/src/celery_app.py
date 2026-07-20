"""
Celery application for distributed task execution
"""
from celery import Celery
import os

# Configure Celery
app = Celery(
    'medical_review',
    broker=os.getenv('CELERY_BROKER_URL', 'redis://localhost:6379/0'),
    backend=os.getenv('CELERY_RESULT_BACKEND', 'redis://localhost:6379/0')
)

# Celery configuration
app.conf.update(
    task_serializer='json',
    accept_content=['json'],
    result_serializer='json',
    timezone='UTC',
    enable_utc=True,
    task_track_started=True,
    task_time_limit=1800,       # 30 minutes max per task (complex reviews can take 20+ min)
    task_soft_time_limit=1680,  # 28 minutes soft limit
    worker_prefetch_multiplier=1,  # One task at a time per worker
    worker_max_tasks_per_child=100,  # Restart worker after 100 tasks
)

# Task routing
app.conf.task_routes = {
    'src.tasks.document_analysis.*': {'queue': 'high_priority'},
    'src.tasks.review.*': {'queue': 'review'},
    'src.tasks.synthesis.*': {'queue': 'high_priority'},
}

# Import tasks (this registers them with Celery)
try:
    from . import tasks
except ImportError:
    pass  # Tasks will be imported when needed
