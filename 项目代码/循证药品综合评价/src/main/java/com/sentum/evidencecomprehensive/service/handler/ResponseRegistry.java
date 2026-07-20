package com.sentum.evidencecomprehensive.service.handler;

import javax.servlet.http.HttpServletResponse;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/9/29
 */
public class ResponseRegistry {
    // 线程安全的映射表：requestId -> response
    private static final Map<String, HttpServletResponse> registry = new ConcurrentHashMap<>();

    /**
     * 注册响应对象
     * @param requestId 请求ID
     * @param response 响应对象
     */
    public static void register(String requestId, HttpServletResponse response) {
        registry.put(requestId, response);
    }

    /**
     * 根据请求ID获取响应对象
     * @param requestId 请求ID
     * @return 对应的响应对象，如果没有则返回null
     */
    public static HttpServletResponse get(String requestId) {
        return registry.get(requestId);
    }

    /**
     * 注销响应对象
     * @param requestId 请求ID
     */
    public static void unregister(String requestId) {
        registry.remove(requestId);
    }
}
