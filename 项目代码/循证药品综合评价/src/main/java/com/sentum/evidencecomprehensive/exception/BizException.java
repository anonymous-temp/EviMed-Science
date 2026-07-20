package com.sentum.evidencecomprehensive.exception;

import com.sentum.evidencecomprehensive.domain.enums.ExceptionEnum;

/**
 * 统一异常处理类
 */
public class BizException extends RuntimeException{
    private Integer code;

    public BizException(Integer code) {
        this.code = code;
    }

    /**
     * 构造器重载，主要是自己考虑某些异常自定义一些返回码
     * @param code 编码
     * @param message 消息
     */
    public BizException(Integer code, String message){
        super(message);
        this.code = code;
    }

    /**
     * 构造器重载
     * @param ExceptionEnum 枚举
     */
    public BizException(ExceptionEnum ExceptionEnum){
        super(ExceptionEnum.getMsg());
        this.code = ExceptionEnum.getCode();
    }


    public Integer getCode() {
        return code;
    }

    public void setCode(Integer code) {
        this.code = code;
    }
}
