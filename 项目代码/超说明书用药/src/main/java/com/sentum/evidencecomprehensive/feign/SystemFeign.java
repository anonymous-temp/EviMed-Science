package com.sentum.evidencecomprehensive.feign;

import com.sentum.evidencecomprehensive.infrastructure.config.FeignTokenInterceptor;
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;

@Component
@FeignClient(name = "evimed-system-v4", configuration = FeignTokenInterceptor.class)
public interface SystemFeign {
    @GetMapping(value = "/system/user/myself")
    String userInfo();
}
