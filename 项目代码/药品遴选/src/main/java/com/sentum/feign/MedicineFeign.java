package com.sentum.feign;

import com.alibaba.fastjson.JSONObject;
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.messaging.handler.annotation.Header;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.annotation.*;

@Component
@FeignClient(name ="sentum-evimed-medicine")
public interface MedicineFeign {
    @PostMapping("/medicine-api/generation")
    String generation(@RequestBody JSONObject dataJson);

    @PostMapping("/medicine-api/gpt-for-pharmacy")
    String gptForPharmacy(@RequestBody JSONObject dataJson);


    @GetMapping("/medicine-api/wechat/create-secret-key")
    JSONObject createSecretKey(@RequestHeader String token, @RequestParam("id") String id, @RequestParam("mail") String mail);


    @PostMapping("/medicine-api/hta-model")
    String gpt4oMini(@RequestBody JSONObject dataJson);

}
