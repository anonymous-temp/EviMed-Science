package com.sentum.feign;

import com.alibaba.fastjson.JSONObject;
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;

@Component
@FeignClient(name = "background-management-v4")
public interface ManageFeign {
    @PostMapping("/backend/dept/add/report/info")
    void addReportInfo(@RequestBody JSONObject sendJson);
}
