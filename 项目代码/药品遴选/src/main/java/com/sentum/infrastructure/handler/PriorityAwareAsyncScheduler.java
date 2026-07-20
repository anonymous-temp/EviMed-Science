package com.sentum.infrastructure.handler;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Comparator;
import java.util.PriorityQueue;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Supplier;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description: 可抢占式 可FIFO的异步任务调度器
 * DateTime: 2025/10/17

 * 优先级异步调度器（支持抢占 + FIFO）
 * 优先级：0-99 普通，100 最高优先级
 * 相同优先级任务按提交顺序（FIFO）执行
 * 使用 CompletableFuture 支持任务编排
 */
public class PriorityAwareAsyncScheduler {

    private static final Logger LOG = LoggerFactory.getLogger(PriorityAwareAsyncScheduler.class);

    private final ExecutorService executor;
//    private final PriorityQueue<AsyncTask> taskQueue;
    private final PriorityBlockingQueue<AsyncTask> taskQueue;
    private final int poolSize;
    private final AtomicLong sequenceCounter = new AtomicLong(0); // 用于 FIFO 顺序
    private volatile boolean running = true;

    // 任务封装类
    // 任务封装类
    private static class AsyncTask implements Comparable<AsyncTask> { // 实现 Comparable 接口
        final CompletableFuture<Void> future;
        final int priority;
        final long sequence;
        final Runnable task;

        AsyncTask(int priority, long sequence, Runnable task) {
            this.priority = priority;
            this.sequence = sequence;
            this.task = task;
            this.future = new CompletableFuture<>();
        }

        @Override
        public int compareTo(AsyncTask other) {
            // 优先级高的排前面（降序）
            if (this.priority != other.priority) {
                return Integer.compare(other.priority, this.priority); // 高优先级在前
            }
            // 优先级相同，按提交顺序（FIFO），序列号小的在前
            return Long.compare(this.sequence, other.sequence);
        }

        @Override
        public String toString() {
            return "AsyncTask{priority=" + priority + ", seq=" + sequence + '}';
        }
    }
//    private static class AsyncTask {
//        final CompletableFuture<Void> future;
//        final int priority;
//        final long sequence; // 用于 FIFO 排序
//        final Runnable task;
//
//        AsyncTask(int priority, long sequence, Runnable task) {
//            this.priority = priority;
//            this.sequence = sequence;
//            this.task = task;
//            this.future = new CompletableFuture<>();
//        }
//
//        @Override
//        public String toString() {
//            return "AsyncTask{priority=" + priority + ", seq=" + sequence + '}';
//        }
//    }

    /**
     * 构造器：指定线程池大小（JDK 8 兼容）
     */
    public PriorityAwareAsyncScheduler(int poolSize) {
        this.poolSize = poolSize;
        this.executor = Executors.newFixedThreadPool(poolSize);

        // PriorityBlockingQueue 可以自动根据 compareTo 方法排序
        this.taskQueue = new PriorityBlockingQueue<>();

        // 启动所有工作线程
        for (int i = 0; i < poolSize; i++) {
            scheduleWorker();
        }
    }
//    public PriorityAwareAsyncScheduler(int poolSize) {
//        this.poolSize = poolSize;
//        this.executor = Executors.newFixedThreadPool(poolSize);
//
//        // 自定义比较器：优先级高者优先；优先级相同时，序列号小者优先（FIFO）
//        this.taskQueue = new PriorityQueue<>(new Comparator<AsyncTask>() {
//            @Override
//            public int compare(AsyncTask a, AsyncTask b) {
//                // 优先级高的排前面（降序）
//                if (a.priority != b.priority) {
//                    return Integer.compare(b.priority, a.priority); // 高优先级在前
//                }
//                // 优先级相同，按提交顺序（FIFO），序列号小的在前
//                return Long.compare(a.sequence, b.sequence);
//            }
//        });
//
//        // 启动所有工作线程
//        for (int i = 0; i < poolSize; i++) {
//            scheduleWorker();
//        }
//    }

    /**
     * 提交一个无返回值的任务（返回 CompletableFuture<Void>）
     * @param priority 优先级 [0, 100]，100 为最高
     * @param task 待执行任务
     * @return 可编排的 CompletableFuture
     */
    public synchronized CompletableFuture<Void> submit(int priority, Runnable task) {
        if (priority < 0 || priority > 100) {
            throw new IllegalArgumentException("Priority must be in [0, 100]");
        }
        if (task == null) {
            throw new NullPointerException("Task cannot be null");
        }

        long seq = sequenceCounter.getAndIncrement();
        AsyncTask asyncTask = new AsyncTask(priority, seq, task);
        taskQueue.offer(asyncTask);

        // 任务提交后立即尝试唤醒一个工作线程（非必须，但提升响应性）
        return asyncTask.future;
    }

    /**
     * 提交一个有返回值的任务（Supplier）
     * @param priority 优先级
     * @param supplier 任务逻辑
     * @param <T> 返回类型
     * @return CompletableFuture<T>
     */
    public synchronized <T> CompletableFuture<T> submit(int priority, Supplier<T> supplier) {
        CompletableFuture<T> future = new CompletableFuture<>();
        submit(priority, new Runnable() {
            @Override
            public void run() {
                try {
                    T result = supplier.get();
                    future.complete(result);
                } catch (Throwable t) {
                    future.completeExceptionally(t);
                }
            }
        });
        return future;
    }

    /**
     * 工作线程任务：持续从队列中取最高优先级任务执行
     */
    private void scheduleWorker() {
        executor.execute(() -> {
            String threadName = Thread.currentThread().getName();

            while (running || !taskQueue.isEmpty()) {
                AsyncTask task = null;
                try {
                    // 使用 take() 阻塞获取，确保能及时获取到新任务
                    task = (AsyncTask) taskQueue.take();

                    LOG.info(threadName + " executing task: priority=" + task.priority + ", seq=" + task.sequence);

                    try {
                        task.task.run();
                        task.future.complete(null); // 成功完成
                        LOG.info(threadName + " completed task: priority=" + task.priority);
                    } catch (Throwable e) {
                        LOG.error(threadName + " task failed: priority=" + task.priority, e);
                        task.future.completeExceptionally(e); // 异常传播
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    LOG.info(threadName + " interrupted");
                    break;
                }
            }
            LOG.info(threadName + " worker thread ended");
        });
    }

//    private void scheduleWorker() {
//        executor.execute(new Runnable() {
//            @Override
//            public void run() {
//                while (running || !taskQueue.isEmpty()) {
//                    AsyncTask task = taskQueue.poll(); // 非阻塞获取
//
//                    if (task != null) {
//                        try {
//                            task.task.run(); // 执行任务
//                            task.future.complete(null); // 成功完成
//                        } catch (Throwable e) {
//                            task.future.completeExceptionally(e); // 异常传播
//                        }
//                        // 执行完后继续循环，立即尝试下一个任务
//                    } else {
//                        // 没有任务，短暂休眠避免忙等待
//                        try {
//                            Thread.sleep(1); // 10ms，平衡延迟与CPU
//                        } catch (InterruptedException e) {
//                            Thread.currentThread().interrupt();
//                            break;
//                        }
//                    }
//                }
//            }
//        });
//    }

    /**
     * 关闭调度器，等待所有任务完成
     */
    public void shutdown() {
        running = false;
        executor.shutdown();
        try {
            if (!executor.awaitTermination(10, TimeUnit.SECONDS)) {
                executor.shutdownNow();
            }
        } catch (InterruptedException e) {
            executor.shutdownNow();
            Thread.currentThread().interrupt();
        }
    }

    /**
     * 获取当前等待任务数
     */
    public int pendingTaskCount() {
        return taskQueue.size();
    }

    /**
     * 获取线程池大小
     */
    public int getPoolSize() {
        return poolSize;
    }
}
