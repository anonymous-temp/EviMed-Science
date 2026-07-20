package com.sentum.evidencecomprehensive.feign;

import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.domain.dto.feign.OutlineDTO;
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;

import java.util.List;
import java.util.Map;

@Component
@FeignClient(name = "sentum-evimed-medicine")
public interface MedicineFeign {
    @PostMapping("/medicine-api/questions/answers/ps")
    JSONObject outline(@RequestBody OutlineDTO outlineDTO);

    @PostMapping("/medicine-api/generation")
    String generation(@RequestBody JSONObject dataJson);
    
    @GetMapping("/medicine-api/questions/evidence")
    List<Map<String, String>> evidence(@RequestParam("title") String title, @RequestParam("languageFlag") boolean languageFlag, @RequestParam("startYear") Integer startYear, @RequestParam("endYear") Integer endYear, @RequestParam("pageSize") Integer pageSize);

    @PostMapping("/medicine-api/gpt-for-pharmacy")
    String gpt(@RequestBody JSONObject dataJson);
    
    @PostMapping("/medicine-api/hta-model")
    String gpt4oMini(@RequestBody JSONObject dataJson);
}
