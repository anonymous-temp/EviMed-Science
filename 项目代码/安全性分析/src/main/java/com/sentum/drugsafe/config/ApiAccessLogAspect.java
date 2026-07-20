package com.sentum.drugsafe.config;

import cn.hutool.core.util.StrUtil;
import com.alibaba.fastjson.JSONObject;
import lombok.extern.slf4j.Slf4j;
import org.aspectj.lang.JoinPoint;
import org.aspectj.lang.annotation.AfterReturning;
import org.aspectj.lang.annotation.AfterThrowing;
import org.aspectj.lang.annotation.Aspect;
import org.aspectj.lang.annotation.Before;
import org.aspectj.lang.annotation.Pointcut;
import org.aspectj.lang.reflect.MethodSignature;
import org.springframework.stereotype.Component;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * API访问日志切面，修复参数序列化异常问题
 */
@Slf4j
@Aspect
@Component
public class ApiAccessLogAspect {

    // 线程局部变量存储请求开始时间和请求ID
    private ThreadLocal<Long> startTimeThreadLocal = new ThreadLocal<>();
    private ThreadLocal<String> requestIdThreadLocal = new ThreadLocal<>();

    @Pointcut("execution(* com.sentum.drugsafe.controller..*.*(..)) && @within(org.springframework.web.bind.annotation.RestController)")
    public void apiPointcut() {
    }

    @Before("apiPointcut()")
    public void doBefore(JoinPoint joinPoint) {
        ServletRequestAttributes attributes = (ServletRequestAttributes) RequestContextHolder.getRequestAttributes();
        if (attributes == null) {
            return;
        }
        HttpServletRequest request = attributes.getRequest();

        // 生成请求ID
        String requestId = request.getHeader("X-Request-Id");
        if (StrUtil.isBlank(requestId)) {
            requestId = UUID.randomUUID().toString().replaceAll("-", "");
        }
        requestIdThreadLocal.set(requestId);

        // 记录开始时间
        long startTime = System.currentTimeMillis();
        startTimeThreadLocal.set(startTime);

        // 获取方法信息
        MethodSignature signature = (MethodSignature) joinPoint.getSignature();
        Method method = signature.getMethod();
        String className = joinPoint.getTarget().getClass().getSimpleName();
        String methodName = method.getName();

        // 记录请求信息
        log.info("[{}] 收到请求 , 类: {}, 方法: {}, URL: {}, 客户端IP: {}, 请求方式: {}",
                requestId, className, methodName,
                request.getRequestURL().toString(), getClientIp(request), request.getMethod());

        // 记录请求参数（修复序列化异常）
        log.info("[{}] 请求参数: {}", requestId, getRequestParams(joinPoint, request));
    }

    @AfterReturning(pointcut = "apiPointcut()")
    public void doAfterReturning() {
        String requestId = requestIdThreadLocal.get();
        Long startTime = startTimeThreadLocal.get();

        if (requestId != null && startTime != null) {
            long endTime = System.currentTimeMillis();
            log.info("[{}] 请求处理完成，耗时: {}ms", requestId, (endTime - startTime));
        }

        clearThreadLocal();
    }

    @AfterThrowing(pointcut = "apiPointcut()", throwing = "e")
    public void doAfterThrowing(Throwable e) {
        String requestId = requestIdThreadLocal.get();
        Long startTime = startTimeThreadLocal.get();

        if (requestId != null && startTime != null) {
            long endTime = System.currentTimeMillis();
            log.error("[{}] 请求处理异常，耗时: {}ms，错误信息: {}",
                    requestId, (endTime - startTime), e.getMessage(), e);
        }

        clearThreadLocal();
    }

    /**
     * 修复：过滤不可序列化的框架对象（如HttpServletRequest/Response）
     */
    private String getRequestParams(JoinPoint joinPoint, HttpServletRequest request) {
        try {
            String method = request.getMethod();
            if ("GET".equalsIgnoreCase(method)) {
                // GET请求参数从请求参数中获取（不受框架对象影响）
                return JSONObject.toJSONString(request.getParameterMap());
            } else {
                // POST等请求：过滤掉HttpServletRequest/Response等框架对象
                Object[] args = joinPoint.getArgs();
                if (args != null && args.length > 0) {
                    List<Object> validArgs = new ArrayList<>();
                    for (Object arg : args) {
                        // 排除框架相关对象，只保留业务参数
                        if (!(arg instanceof HttpServletRequest) &&
                                !(arg instanceof HttpServletResponse)) {
                            validArgs.add(arg);
                        }
                    }
                    return JSONObject.toJSONString(validArgs);
                }
            }
        } catch (Exception e) {
            log.error("获取请求参数异常", e);
        }
        return "获取参数失败";
    }

    // 其他方法（getClientIp、clearThreadLocal）保持不变
    private String getClientIp(HttpServletRequest request) {
        String ip = request.getHeader("x-forwarded-for");
        if (ip == null || ip.length() == 0 || "unknown".equalsIgnoreCase(ip)) {
            ip = request.getHeader("Proxy-Client-IP");
        }
        if (ip == null || ip.length() == 0 || "unknown".equalsIgnoreCase(ip)) {
            ip = request.getHeader("WL-Proxy-Client-IP");
        }
        if (ip == null || ip.length() == 0 || "unknown".equalsIgnoreCase(ip)) {
            ip = request.getRemoteAddr();
        }
        if (ip != null && ip.contains(",")) {
            ip = ip.split(",")[0].trim();
        }
        return ip;
    }

    private void clearThreadLocal() {
        requestIdThreadLocal.remove();
        startTimeThreadLocal.remove();
    }
}
