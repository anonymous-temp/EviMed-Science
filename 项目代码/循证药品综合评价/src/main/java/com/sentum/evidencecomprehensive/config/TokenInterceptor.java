package com.sentum.evidencecomprehensive.config;

import feign.RequestInterceptor;
import feign.RequestTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

@Component
public class TokenInterceptor implements HandlerInterceptor {

    @Override
    public boolean preHandle(HttpServletRequest request,
                             HttpServletResponse response,
                             Object handler) throws Exception {

        // 从请求头获取token
        String token = request.getHeader("token");

        request.setAttribute("token", token);

        return true;
    }
}
