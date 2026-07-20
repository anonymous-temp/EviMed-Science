package com.sentum.evidencecomprehensive.infrastructure.config;

import org.springframework.retry.RetryCallback;
import org.springframework.retry.RetryContext;

import java.lang.reflect.Type;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/8/6
 */
public class ParameterizedRetryCallback<T> implements RetryCallback<T, Throwable> {

    private final String prompt;
    private final String modelType;
    private final Type typeToken;
    private final String tips;
    private final RetryCallback<T, Throwable> delegate;

    public ParameterizedRetryCallback(String prompt, String modelType, Type typeToken, String tips,
                                      RetryCallback<T, Throwable> delegate) {
        this.prompt = prompt;
        this.modelType = modelType;
        this.typeToken = typeToken;
        this.tips = tips;
        this.delegate = delegate;
    }

    @Override
    public T doWithRetry(RetryContext context) throws Throwable {
        // 在 callback 执行前设置属性
        context.setAttribute("tips", tips);
        context.setAttribute("prompt", prompt);
        context.setAttribute("modelType", modelType);
        context.setAttribute("typeToken", typeToken.getTypeName());

        return delegate.doWithRetry(context);
    }

    // Getters for listener access
    public String getTips() { return tips; }
    public String getPrompt() { return prompt; }
    public String getModelType() { return modelType; }
    public Type getTypeToken() { return typeToken; }
}