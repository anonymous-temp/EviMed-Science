package com.sentum.exception;

import com.sentum.pojo.vo.DataResult;
import lombok.extern.slf4j.Slf4j;
import org.springframework.validation.FieldError;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import javax.servlet.http.HttpServletRequest;
import java.util.List;
import java.util.stream.Collectors;

@Slf4j
@RestControllerAdvice
public class GlobalExceptionHandler {

    /**
     * 处理限流异常
     */
    @ExceptionHandler(RateLimitException.class)
    public DataResult handleRateLimitException(RateLimitException e, HttpServletRequest request) {
        String requestURI = request.getRequestURI();
        log.warn("请求被限流 - URI: {}, 异常信息: {}", requestURI, e.getMessage());

        DataResult result = DataResult.error(429, "请求过于频繁，请稍后重试");

        // 添加额外信息
        if (e.getKey() != null) {
            result.put("limitKey", e.getKey());
        }
        if (e.getPriority() != null) {
            result.put("priority", e.getPriority());
        }
        if (e.getWaitTime() != null) {
            result.put("suggestWaitTime", e.getWaitTime() + "ms");
        }

        result.put("path", requestURI);
        result.put("timestamp", System.currentTimeMillis());

        return result;
    }

    /**
     * 处理参数校验异常
     */
    @ExceptionHandler(MethodArgumentNotValidException.class)
    public DataResult handleMethodArgumentNotValidException(MethodArgumentNotValidException e) {
        log.warn("参数校验失败: {}", e.getMessage());

        List<String> errors = e.getBindingResult()
                .getFieldErrors()
                .stream()
                .map(FieldError::getDefaultMessage)
                .collect(Collectors.toList());

        return DataResult.error(400, "参数校验失败")
                .put("errors", errors)
                .put("timestamp", System.currentTimeMillis());
    }

    /**
     * 处理业务异常
     */
    @ExceptionHandler(BusinessException.class)
    public DataResult handleBusinessException(BusinessException e, HttpServletRequest request) {
        String requestURI = request.getRequestURI();
        log.warn("业务异常 - URI: {}, 异常信息: {}", requestURI, e.getMessage());

        return DataResult.error(e.getCode(), e.getMessage())
                .put("path", requestURI)
                .put("timestamp", System.currentTimeMillis());
    }


    /**
     * 处理非法参数异常
     */
    @ExceptionHandler(IllegalArgumentException.class)
    public DataResult handleIllegalArgumentException(IllegalArgumentException e, HttpServletRequest request) {
        String requestURI = request.getRequestURI();
        log.error("参数异常 - URI: {}, 异常信息: {}", requestURI, e.getMessage(), e);

        return DataResult.error(400, "参数错误: " + e.getMessage())
                .put("path", requestURI)
                .put("timestamp", System.currentTimeMillis());
    }

    /**
     * 处理空指针异常
     */
    @ExceptionHandler(NullPointerException.class)
    public DataResult handleNullPointerException(NullPointerException e, HttpServletRequest request) {
        String requestURI = request.getRequestURI();
        log.error("空指针异常 - URI: {}", requestURI, e);

        // 生产环境不要暴露详细错误信息
        String message = isProduction() ? "服务器内部错误" : "空指针异常: " + e.getMessage();

        return DataResult.error(500, message)
                .put("path", requestURI)
                .put("timestamp", System.currentTimeMillis());
    }

    /**
     * 处理运行时异常
     */
    @ExceptionHandler(RuntimeException.class)
    public DataResult handleRuntimeException(RuntimeException e, HttpServletRequest request) {
        String requestURI = request.getRequestURI();
        log.error("运行时异常 - URI: {}", requestURI, e);

        // 判断是否有特定的包装异常
        Throwable cause = e.getCause();
        if (cause instanceof RateLimitException) {
            return handleRateLimitException((RateLimitException) cause, request);
        }

        // 生产环境不要暴露详细错误信息
        String message = isProduction() ? "服务器内部错误" : e.getMessage();

        return DataResult.error(500, message)
                .put("path", requestURI)
                .put("timestamp", System.currentTimeMillis());
    }

    /**
     * 处理所有其他异常
     */
    @ExceptionHandler(Exception.class)
    public DataResult handleException(Exception e, HttpServletRequest request) {
        String requestURI = request.getRequestURI();
        log.error("未知异常 - URI: {}", requestURI, e);

        // 生产环境不要暴露详细错误信息
        String message = isProduction() ? "服务器内部错误，请联系管理员" : e.getMessage();

        return DataResult.error(500, message)
                .put("path", requestURI)
                .put("timestamp", System.currentTimeMillis())
                .put("error", e.getClass().getSimpleName());
    }

    /**
     * 判断是否生产环境
     */
    private boolean isProduction() {
        String profile = System.getProperty("spring.profiles.active", "dev");
        return "prod".equalsIgnoreCase(profile) || "production".equalsIgnoreCase(profile);
    }
}
