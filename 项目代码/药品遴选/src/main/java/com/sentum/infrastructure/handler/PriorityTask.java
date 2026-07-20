package com.sentum.infrastructure.handler;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.function.Supplier;

/**
 * 优先级任务包装器
 * 支持优先级排序和异步结果获取
 */
public class PriorityTask<T> implements Comparable<PriorityTask<T>> {

    private final Supplier<T> task;
    private final String taskName;
    private final int priority; // 数字越小优先级越高
    private final TaskMetrics metrics;
    private final long createTime;

    // 用于异步结果传递
    private final CompletableFuture<T> resultFuture;
    private final CountDownLatch completionLatch;

    // 任务状态
    private volatile TaskStatus status;
    private volatile T result;
    private volatile Exception exception;

    public PriorityTask(Supplier<T> task, String taskName, int priority, TaskMetrics metrics) {
        this.task = task;
        this.taskName = taskName;
        this.priority = priority;
        this.metrics = metrics;
        this.createTime = System.currentTimeMillis();
        this.resultFuture = new CompletableFuture<>();
        this.completionLatch = new CountDownLatch(1);
        this.status = TaskStatus.PENDING;
    }

    /**
     * 执行任务
     */
    public T execute() {
        try {
            status = TaskStatus.RUNNING;
            metrics.setStartTime(System.currentTimeMillis());

            T taskResult = task.get();

            this.result = taskResult;
            this.status = TaskStatus.COMPLETED;

            // 通知等待的线程
            resultFuture.complete(taskResult);
            completionLatch.countDown();

            return taskResult;

        } catch (Exception e) {
            this.exception = e;
            this.status = TaskStatus.FAILED;

            // 通知异常
            resultFuture.completeExceptionally(e);
            completionLatch.countDown();

            throw new RuntimeException("Task execution failed: " + taskName, e);
        }
    }

    /**
     * 异步获取结果
     */
    public CompletableFuture<T> getResultAsync() {
        return resultFuture;
    }

    /**
     * 同步等待结果
     */
    public T waitForResult() throws InterruptedException {
        completionLatch.await();
        if (exception != null) {
            throw new RuntimeException("Task failed: " + taskName, exception);
        }
        return result;
    }

    /**
     * 带超时的等待结果
     */
    public T waitForResult(long timeout, java.util.concurrent.TimeUnit unit)
            throws InterruptedException, java.util.concurrent.TimeoutException {
        if (completionLatch.await(timeout, unit)) {
            if (exception != null) {
                throw new RuntimeException("Task failed: " + taskName, exception);
            }
            return result;
        } else {
            throw new java.util.concurrent.TimeoutException("Task timeout: " + taskName);
        }
    }

    /**
     * 设置结果（供调度器使用）
     */
    public void setResult(Object result) {
        try {
            @SuppressWarnings("unchecked")
            T typedResult = (T) result;
            this.result = typedResult;
            this.status = TaskStatus.COMPLETED;
            resultFuture.complete(typedResult);
            completionLatch.countDown();
        } catch (Exception e) {
            setException(e);
        }
    }

    /**
     * 设置异常（供调度器使用）
     */
    public void setException(Exception exception) {
        this.exception = exception;
        this.status = TaskStatus.FAILED;
        resultFuture.completeExceptionally(exception);
        completionLatch.countDown();
    }

    /**
     * 取消任务
     */
    public boolean cancel() {
        if (status == TaskStatus.PENDING) {
            status = TaskStatus.CANCELLED;
            resultFuture.cancel(true);
            completionLatch.countDown();
            return true;
        }
        return false;
    }

    /**
     * 优先级比较 - 数字越小优先级越高
     * 相同优先级按创建时间排序（先创建的先执行）
     */
    @Override
    public int compareTo(PriorityTask<T> other) {
        int priorityCompare = Integer.compare(this.priority, other.priority);
        if (priorityCompare != 0) {
            return priorityCompare;
        }
        // 优先级相同时，按创建时间排序
        return Long.compare(this.createTime, other.createTime);
    }

    /**
     * 计算任务等待时间
     */
    public long getWaitingTime() {
        if (status == TaskStatus.PENDING) {
            return System.currentTimeMillis() - createTime;
        }
        return metrics.getStartTime() - createTime;
    }

    /**
     * 获取任务年龄（从创建到现在的时间）
     */
    public long getAge() {
        return System.currentTimeMillis() - createTime;
    }

    /**
     * 判断任务是否已完成
     */
    public boolean isCompleted() {
        return status == TaskStatus.COMPLETED || status == TaskStatus.FAILED || status == TaskStatus.CANCELLED;
    }

    /**
     * 判断任务是否正在运行
     */
    public boolean isRunning() {
        return status == TaskStatus.RUNNING;
    }

    // Getters
    public Supplier<T> getTask() { return task; }
    public String getTaskName() { return taskName; }
    public int getPriority() { return priority; }
    public TaskMetrics getMetrics() { return metrics; }
    public long getCreateTime() { return createTime; }
    public TaskStatus getStatus() { return status; }
    public T getResult() { return result; }
    public Exception getException() { return exception; }

    @Override
    public String toString() {
        return String.format("PriorityTask{name='%s', priority=%d, status=%s, age=%dms}",
                taskName, priority, status, getAge());
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof PriorityTask)) return false;
        PriorityTask<?> that = (PriorityTask<?>) o;
        return priority == that.priority &&
                createTime == that.createTime &&
                taskName.equals(that.taskName);
    }

    @Override
    public int hashCode() {
        return java.util.Objects.hash(taskName, priority, createTime);
    }
}

/**
 * 任务状态枚举
 */
enum TaskStatus {
    PENDING("等待中"),
    RUNNING("执行中"),
    COMPLETED("已完成"),
    FAILED("执行失败"),
    CANCELLED("已取消");

    private final String description;

    TaskStatus(String description) {
        this.description = description;
    }

    public String getDescription() {
        return description;
    }

    @Override
    public String toString() {
        return description;
    }
}