package com.sentum.evidencecomprehensive.aspect;

import cn.hutool.core.date.StopWatch;
import cn.hutool.core.util.StrUtil;
import cn.hutool.json.JSONUtil;
import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.constants.Constants;
import com.sentum.evidencecomprehensive.utils.RedisUtil;
import lombok.extern.slf4j.Slf4j;
import org.aspectj.lang.ProceedingJoinPoint;
import org.aspectj.lang.annotation.Around;
import org.aspectj.lang.annotation.Aspect;
import org.aspectj.lang.reflect.MethodSignature;
import org.springframework.stereotype.Component;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

import javax.servlet.ServletRequest;
import javax.servlet.ServletResponse;
import javax.servlet.http.HttpServletRequest;
import java.lang.reflect.Method;
import java.util.List;
import java.util.Objects;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * 日志切面
 *
 */
@Aspect
@Slf4j
@Component
public class WebLogAspect {
    
    /**
     * 接收到请求，记录请求内容
     * 所有controller包下所有的类的方法，都是切点
     * 特别注意：由于info级别日志已经包含了warn级别日志。如果开了info级别日志，warn就不会打印了。
     */
    @Around("execution(* com..controller..*.*(..))")
    public Object around(ProceedingJoinPoint joinPoint) throws Throwable {
        HttpServletRequest request = ((ServletRequestAttributes) Objects.requireNonNull(RequestContextHolder.getRequestAttributes())).getRequest();
        String methodName = ((MethodSignature) joinPoint.getSignature()).getMethod().getName();
//        String method = request.getMethod();
        String uri = request.getRequestURI();
        String header = request.getHeader("token");
        JSONObject userInfo = new JSONObject();
//        if (StrUtil.isNotBlank(header)) {
//            String token = request.getHeader("token");
//            Object redis = RedisUtil.redis.opsForValue().get(Constants.ACCESS_TOKEN + token);
//            assert redis != null;
//            userInfo = JSONObject.parseObject(redis.toString());
//        }
        //如果参数有HttpRequest,ServletResponse，直接移除，不打印这些 
        List<Object> paramList = Stream.of(joinPoint.getArgs())
                .filter(args -> !(args instanceof ServletRequest))
                .filter(args -> !(args instanceof ServletResponse))
                .collect(Collectors.toList());
        String printParamStr = paramList.size() == 1 ? JSONUtil.toJsonStr(paramList.get(0)) : JSONUtil.toJsonStr(paramList);
        if (log.isInfoEnabled()) {
//            log.info("[{}][{}]【base:{}】【request:{}】", method, uri, JSON.toJSONString(userInfo.get("userName")) + JSON.toJSONString(userInfo.get("loginName")), printParamStr);
            log.info("[{}][{}]【request:{}】", methodName, uri, printParamStr);
        }
        StopWatch stopWatch = new StopWatch();
        stopWatch.start();
        Object result = joinPoint.proceed();
        stopWatch.stop();
        long cost = stopWatch.getTotalTimeMillis();
        if (Constants.LOG_FILTER_METHOD_NAME.contains(methodName) || Constants.LOG_FILTER_METHOD_NAME.contains(uri)) {
            return result;
        }
        String printResultStr = JSONUtil.toJsonStr(result);
        if (log.isInfoEnabled()) {
            log.info("[{}]【response:{}】[cost:{}ms]", uri, printResultStr, cost);
        }
        return result;
    }


}