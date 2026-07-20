package com.sentum.exception;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description: 
 * DateTime: 2025/9/18
 */

/**
 * 业务异常
 */
public class BusinessException extends RuntimeException {

    private int code;

    public BusinessException(String message) {
        super(message);
        this.code = 500;
    }

    public BusinessException(int code, String message) {
        super(message);
        this.code = code;
    }

    public BusinessException(String message, Throwable cause) {
        super(message, cause);
        this.code = 500;
    }

    public BusinessException(int code, String message, Throwable cause) {
        super(message, cause);
        this.code = code;
    }

    public int getCode() {
        return code;
    }
}
