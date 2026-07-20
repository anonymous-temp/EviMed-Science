package com.sentum.drugsafe.feign;


import com.alibaba.fastjson.JSONObject;
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.PostMapping;

@FeignClient("sentum-evimed-offlabel")
public interface ClinicalTrialFeign {
    @PostMapping("/clinical-api/evimed/searchClinical")
   JSONObject getClinical(JSONObject jsonObject);
}
