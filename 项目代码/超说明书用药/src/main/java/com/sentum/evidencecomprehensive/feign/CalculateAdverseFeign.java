package com.sentum.evidencecomprehensive.feign;

import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;

@Component
@FeignClient("CALCULATE-TYPICAL-ADVERSE-REACTIONS")
public interface CalculateAdverseFeign {
    @GetMapping("/web-service")
    String calculate(@RequestParam(name = "a") String a, @RequestParam(name = "b") String b,
                     @RequestParam(name = "c") String c, @RequestParam(name = "d") String d);
}
