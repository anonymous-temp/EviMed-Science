package com.sentum.pojo.bo.other;

import java.lang.reflect.Type;
import java.util.concurrent.CompletableFuture;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description: 优先级请求任务
 * DateTime: 2025/10/28
 */
public class PriorityTask {
    private final String prompt;
    private final String modelType;
    private final Type typeToken;
    private final String tips;
    private final int priority;
    private final long submitTime;
    private final CompletableFuture<Object> future;

    public PriorityTask(String prompt, String modelType, Type typeToken, String tips, int priority) {
        this.prompt = prompt;
        this.modelType = modelType;
        this.typeToken = typeToken;
        this.tips = tips;
        this.priority = priority;
        this.submitTime = System.currentTimeMillis();
        this.future = new CompletableFuture<>();
    }

    // getters...
    public String getPrompt() { return prompt; }
    public String getModelType() { return modelType; }
    public Type getTypeToken() { return typeToken; }
    public String getTips() { return tips; }
    public int getPriority() { return priority; }
    public long getSubmitTime() { return submitTime; }
    public CompletableFuture<Object> getFuture() { return future; }
}
