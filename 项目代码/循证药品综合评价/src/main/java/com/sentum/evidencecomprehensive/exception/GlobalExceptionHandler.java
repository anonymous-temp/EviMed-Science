package com.sentum.evidencecomprehensive.exception;


import com.sentum.evidencecomprehensive.domain.enums.ExceptionEnum;
import com.sentum.evidencecomprehensive.domain.vo.DataResult;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ControllerAdvice;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.ResponseBody;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@Slf4j
@RestControllerAdvice
public class GlobalExceptionHandler {

    /**
     * validation参数校验异常
     */
    @ExceptionHandler(value = MethodArgumentNotValidException.class)
    public DataResult methodArgumentNotValidExceptionExceptionHandler(MethodArgumentNotValidException e) {
        StringBuilder errorMsg = new StringBuilder();

        e.getBindingResult().getFieldErrors().forEach(x -> errorMsg.append(x.getField()).append(x.getDefaultMessage()).append(","));
        String message = errorMsg.toString();
        log.info("validation parameters error！The reason is:{}", message);
        return DataResult.error(ExceptionEnum.ParamException.getCode(), message.substring(0, message.length() - 1));
    }

    @ExceptionHandler(value = IllegalArgumentException.class)
    public DataResult illegalArgumentExceptionHandler(IllegalArgumentException e) {
        String message = e.getMessage();
        log.info("validation parameters error！The reason is:{}", message);
        return DataResult.error(ExceptionEnum.FALSE.getCode(), message.substring(0, message.length() - 1));
    }

    /**
     * 处理系统内部异常
     * @param e 异常
     * @return 返回值
     */
    @ExceptionHandler(Exception.class)
    public DataResult handleException(Exception e){
        if (!(e instanceof java.io.IOException)) {
            log.error(e.getMessage(), e);
        }
        return DataResult.error(ExceptionEnum.SystemException.getCode(),
                ExceptionEnum.ServiceException.getMsg());
    }

    /**
     * 处理自定义异常
     * @param e 异常
     * @return 返回值
     */
    @ExceptionHandler(BizException.class)
    public DataResult handleMyException(BizException e){
        log.error(e.getMessage(),e);
        return DataResult.error(e.getCode(), e.getMessage());
    }

    /**
     * 处理自定义异常  
     * @param e 异常
     * @return 返回值
     */
    @ExceptionHandler(BusinessException.class)
    public DataResult handleBusinessException(BusinessException e){
        log.error(e.getMessage(),e);
        return DataResult.error(e.getErrorCode(), e.getErrorMsg());
    }
}
