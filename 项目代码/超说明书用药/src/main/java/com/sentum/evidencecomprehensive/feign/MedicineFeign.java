package com.sentum.evidencecomprehensive.feign;

import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.pojo.dto.QuestionDto;
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;

/**
 * Description:
 * DateTime: 2024/4/16
 */
@Component
@FeignClient("sentum-evimed-medicine")
public interface MedicineFeign {

    @PostMapping("/medicine-api/questions/answers/ps")
    JSONObject outline(@RequestBody QuestionDto questionDto);

    @PostMapping("/medicine-api/generation")
    String generation(@RequestBody JSONObject dataJson);

    @PostMapping("/medicine-api/gpt-for-pharmacy")
    String gpt4o(@RequestBody JSONObject dataJson);

    @PostMapping("/medicine-api/hta-model")
    String gpt4oMini(@RequestBody JSONObject dataJson);
}
