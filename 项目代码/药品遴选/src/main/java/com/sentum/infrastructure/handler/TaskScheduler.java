package com.sentum.infrastructure.handler;

import cn.hutool.core.thread.ThreadFactoryBuilder;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Comparator;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.*;
import java.util.function.Supplier;

/**
 * 智能任务调度器 - 支持多级优先级和动态线程分配
 */
public class TaskScheduler {
    
    private static final Logger log = LoggerFactory.getLogger(TaskScheduler.class);

    // 核心线程池：处理必须优先完成的任务
    private final ThreadPoolExecutor coreExecutor;

    // 长时间重要任务线程池：专门处理耗时但重要的任务
    private final ThreadPoolExecutor longRunningExecutor;

    // 普通任务线程池：处理一般任务
    private final ThreadPoolExecutor normalExecutor;

    // 灵活线程池：可以动态分配给需要的任务
    private final ThreadPoolExecutor flexibleExecutor;

    // 任务优先级队列
    private final PriorityBlockingQueue<PriorityTask> taskQueue;

    // 任务监控
    private final Map<String, TaskMetrics> taskMetrics;

    public TaskScheduler() {
        // 核心线程池：3个线程，专门处理关键任务
        this.coreExecutor = new ThreadPoolExecutor(
                1, 1, 0L, TimeUnit.MILLISECONDS,
                new LinkedBlockingQueue<>(),
                new ThreadFactoryBuilder().setNamePrefix("Core-Task-%d").build(),
                new ThreadPoolExecutor.CallerRunsPolicy()
        );

        // 长时间重要任务线程池：2个线程，按顺序处理
        this.longRunningExecutor = new ThreadPoolExecutor(
                2, 2, 60L, TimeUnit.SECONDS,
                new LinkedBlockingQueue<>(),
                new ThreadFactoryBuilder().setNamePrefix("LongRunning-Task-%d").build(),
                new ThreadPoolExecutor.CallerRunsPolicy()
        );

//        // ✅ 使用自定义比较器的优先级队列
//        this.longRunningExecutor = new ThreadPoolExecutor(
//                1, 2, 60L, TimeUnit.SECONDS,
//                new PriorityBlockingQueue<>(11, new Comparator<Runnable>() {
//                    @Override
//                    public int compare(Runnable r1, Runnable r2) {
//                        // 简单的优先级比较，可以根据需要调整
//                        return 0; // 或者实现更复杂的比较逻辑
//                    }
//                }),
//                new ThreadFactoryBuilder().setNamePrefix("LongRunning-Task-%d").build(),
//                new ThreadPoolExecutor.CallerRunsPolicy()
//        );


        // 普通任务线程池：2个线程
        this.normalExecutor = new ThreadPoolExecutor(
                3, 3, 60L, TimeUnit.SECONDS,
                new LinkedBlockingQueue<>(),
                new ThreadFactoryBuilder().setNamePrefix("Normal-Task-%d").build(),
                new ThreadPoolExecutor.CallerRunsPolicy()
        );

        // 灵活线程池：可动态调整
        this.flexibleExecutor = new ThreadPoolExecutor(
                1, 3, 30L, TimeUnit.SECONDS,
                new LinkedBlockingQueue<>(),
                new ThreadFactoryBuilder().setNamePrefix("Flexible-Task-%d").build(),
                new ThreadPoolExecutor.CallerRunsPolicy()
        );

        this.taskQueue = new PriorityBlockingQueue<>();
        this.taskMetrics = new ConcurrentHashMap<>();

        // 启动智能调度器
        startIntelligentScheduler();
    }

    /**
     * 获取灵活线程池执行器
     */
    public ThreadPoolExecutor getFlexibleExecutor() {
        return flexibleExecutor;
    }

    /**
     * 获取核心线程池执行器
     */
    public ThreadPoolExecutor getCoreExecutor() {
        return coreExecutor;
    }

    /**
     * 获取长时间任务线程池执行器
     */
    public ThreadPoolExecutor getLongRunningExecutor() {
        return longRunningExecutor;
    }

    /**
     * 获取普通任务线程池执行器
     */
    public ThreadPoolExecutor getNormalExecutor() {
        return normalExecutor;
    }

    /**
     * 获取任务指标信息
     */
    public Map<String, TaskMetrics> getTaskMetrics() {
        return new HashMap<>(taskMetrics); // 返回副本，避免外部修改
    }

    /**
     * 获取当前队列中的任务数量
     */
    public int getQueueSize() {
        return taskQueue.size();
    }

    /**
     * 获取所有线程池的状态信息
     */
    public String getThreadPoolStatus() {
        StringBuilder status = new StringBuilder();
        status.append("=== 线程池状态 ===\n");
        status.append(String.format("核心线程池: 活跃=%d, 核心=%d, 最大=%d, 队列=%d\n",
                coreExecutor.getActiveCount(), coreExecutor.getCorePoolSize(),
                coreExecutor.getMaximumPoolSize(), coreExecutor.getQueue().size()));
        status.append(String.format("长时间线程池: 活跃=%d, 核心=%d, 最大=%d, 队列=%d\n",
                longRunningExecutor.getActiveCount(), longRunningExecutor.getCorePoolSize(),
                longRunningExecutor.getMaximumPoolSize(), longRunningExecutor.getQueue().size()));
        status.append(String.format("普通线程池: 活跃=%d, 核心=%d, 最大=%d, 队列=%d\n",
                normalExecutor.getActiveCount(), normalExecutor.getCorePoolSize(),
                normalExecutor.getMaximumPoolSize(), normalExecutor.getQueue().size()));
        status.append(String.format("灵活线程池: 活跃=%d, 核心=%d, 最大=%d, 队列=%d\n",
                flexibleExecutor.getActiveCount(), flexibleExecutor.getCorePoolSize(),
                flexibleExecutor.getMaximumPoolSize(), flexibleExecutor.getQueue().size()));
        status.append(String.format("优先级队列: 待处理=%d\n", taskQueue.size()));
        return status.toString();
    }
    
    /**
     * 提交核心关键任务（最高优先级）
     */
    public <T> CompletableFuture<T> submitCriticalTask(Supplier<T> task, String taskName, int priority) {
        TaskMetrics metrics = new TaskMetrics(taskName, System.currentTimeMillis());
        taskMetrics.put(taskName, metrics);

        return CompletableFuture.supplyAsync(() -> {
            log.info("开始执行核心任务: {}", taskName);
            long startTime = System.currentTimeMillis();
            try {
                T result = task.get();
                metrics.setCompleted(System.currentTimeMillis() - startTime);
                log.info("核心任务 {} 完成，耗时: {}ms", taskName, metrics.getExecutionTime());
                return result;
            } catch (Exception e) {
                metrics.setFailed(e);
                log.error("核心任务 {} 执行失败", taskName, e);
                throw new RuntimeException(e);
            }
        }, coreExecutor);
    }

    /**
     * 提交长时间重要任务（高优先级，但按顺序执行）
     */
    public <T> CompletableFuture<T> submitLongRunningImportantTask(Supplier<T> task, String taskName, int priority) {
        TaskMetrics metrics = new TaskMetrics(taskName, System.currentTimeMillis());
        taskMetrics.put(taskName, metrics);

        PriorityTask<T> priorityTask = new PriorityTask<>(task, taskName, priority, metrics);

        return CompletableFuture.supplyAsync(() -> {
            // 检查是否有空闲线程可以立即执行
            if (longRunningExecutor.getActiveCount() < longRunningExecutor.getCorePoolSize()) {
                log.info("发现空闲线程，立即执行长时间重要任务: {}", taskName);
                return executeTaskWithMetrics(task, taskName, metrics);
            } else {
                // 加入优先级队列等待执行
                log.info("长时间重要任务 {} 加入队列等待执行，优先级: {}", taskName, priority);
                taskQueue.offer(priorityTask);

                // 等待调度器分配执行
                return waitForScheduledExecution(priorityTask);
            }
        }, longRunningExecutor);
    }

//    public <T> CompletableFuture<T> submitLongRunningImportantTask(Supplier<T> task, String taskName, int priority) {
//        TaskMetrics metrics = new TaskMetrics(taskName, System.currentTimeMillis());
//        taskMetrics.put(taskName, metrics);
//
//        // ✅ 直接使用普通线程池，优先级通过我们的调度器处理
//        if (longRunningExecutor.getActiveCount() < longRunningExecutor.getCorePoolSize()) {
//            // 有空闲线程，直接执行
//            log.info("发现空闲线程，立即执行长时间重要任务: {}", taskName);
//            return CompletableFuture.supplyAsync(() -> {
//                return executeTaskWithMetrics(task, taskName, metrics);
//            }, longRunningExecutor);
//        } else {
//            // 没有空闲线程，加入优先级队列等待调度
//            log.info("长时间重要任务 {} 加入队列等待执行，优先级: {}", taskName, priority);
//            PriorityTask<T> priorityTask = new PriorityTask<>(task, taskName, priority, metrics);
//            taskQueue.offer(priorityTask);
//
//            // 返回异步结果
//            return priorityTask.getResultAsync();
//        }
//    }

    /**
     * 提交普通任务（可并行执行）
     */
    public <T> CompletableFuture<T> submitNormalTask(Supplier<T> task, String taskName, int priority) {
        TaskMetrics metrics = new TaskMetrics(taskName, System.currentTimeMillis());
        taskMetrics.put(taskName, metrics);

        return CompletableFuture.supplyAsync(() -> {
            return executeTaskWithMetrics(task, taskName, metrics);
        }, normalExecutor);
    }
    
    /**
     * 执行带指标监控的任务 - 修复后的方法
     */
    private <T> T executeTaskWithMetrics(Supplier<T> task, String taskName, TaskMetrics metrics) {
        try {
            // 记录开始执行时间
            metrics.setStartTime(System.currentTimeMillis());

            log.info("开始执行任务: {}", taskName);

            // 执行任务
            T result = task.get();

            // 记录执行完成
            long executionTime = System.currentTimeMillis() - metrics.getStartTime();
            metrics.setCompleted(executionTime);

            log.info("任务 {} 执行完成，耗时: {}ms", taskName, executionTime);
            return result;

        } catch (Exception e) {
            // 记录执行失败
            metrics.setFailed(e);
            log.error("任务 {} 执行失败: {}", taskName, e.getMessage(), e);
            throw new RuntimeException("Task execution failed: " + taskName, e);
        }
    }

    /**
     * 等待调度执行的任务结果
     */
    private <T> T waitForScheduledExecution(PriorityTask<T> priorityTask) {
        try {
            return priorityTask.waitForResult();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new RuntimeException("Task interrupted: " + priorityTask.getTaskName(), e);
        }
    }
    
    
    /**
     * 启动智能调度器
     */
    private void startIntelligentScheduler() {
        // 调度器线程，负责智能分配任务
        Thread scheduler = new Thread(() -> {
            while (!Thread.currentThread().isInterrupted()) {
                try {
                    // 检查是否有待执行的优先级任务
                    PriorityTask<?> task = taskQueue.poll(1, TimeUnit.SECONDS);
                    if (task != null) {
                        // 寻找最合适的线程池执行
                        ExecutorService bestExecutor = findBestExecutor(task);

                        bestExecutor.submit(() -> {
                            log.info("调度器分配任务 {} 到线程池执行", task.getTaskName());
                            Object result = executeTaskWithMetrics(
                                    task.getTask(),
                                    task.getTaskName(),
                                    task.getMetrics()
                            );
                            task.setResult(result);
                        });
                    }

                    // 动态调整线程池大小
                    adjustThreadPoolSizes();

                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                } catch (Exception e) {
                    log.error("调度器执行异常", e);
                }
            }
        }, "Task-Scheduler");

        scheduler.setDaemon(true);
        scheduler.start();
    }

    /**
     * 寻找最佳执行器
     */
    private ExecutorService findBestExecutor(PriorityTask<?> task) {
        // 优先选择空闲度最高的线程池
        Map<ExecutorService, Double> idleRates = new HashMap<>();

        idleRates.put(longRunningExecutor, calculateIdleRate(longRunningExecutor));
        idleRates.put(normalExecutor, calculateIdleRate(normalExecutor));
        idleRates.put(flexibleExecutor, calculateIdleRate(flexibleExecutor));

        // 根据任务类型和线程池空闲率选择最佳执行器
        if (task.getTaskName().contains("Guide") || task.getTaskName().contains("Paper")) {
            // 长时间任务优先使用专用线程池
            if (calculateIdleRate(longRunningExecutor) > 0.3) {
                return longRunningExecutor;
            }
        }

        // 选择空闲率最高的线程池
        return idleRates.entrySet().stream()
                .max(Map.Entry.comparingByValue())
                .map(Map.Entry::getKey)
                .orElse(flexibleExecutor);
    }

    /**
     * 计算线程池空闲率
     */
    private double calculateIdleRate(ThreadPoolExecutor executor) {
        int activeCount = executor.getActiveCount();
        int corePoolSize = executor.getCorePoolSize();
        return corePoolSize == 0 ? 0 : (double)(corePoolSize - activeCount) / corePoolSize;
    }

    /**
     * 动态调整线程池大小
     */
    private void adjustThreadPoolSizes() {
        // 根据当前任务队列长度与线程池的使用情况动态调整线程池大小
        // 这里可以根据具体需求进行调整策略
    }

    /**
     * 关闭调度器
     */
    public void shutdown() {
        coreExecutor.shutdown();
        longRunningExecutor.shutdown();
        normalExecutor.shutdown();
        flexibleExecutor.shutdown();
    }
}
