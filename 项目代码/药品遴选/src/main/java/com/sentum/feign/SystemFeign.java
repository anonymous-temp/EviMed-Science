package com.sentum.feign;

import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestHeader;

@Component
@FeignClient("evimed-system-v4")
public interface SystemFeign {
    @GetMapping("/system/user/myself")
    String userInfo(@RequestHeader String token);
}
