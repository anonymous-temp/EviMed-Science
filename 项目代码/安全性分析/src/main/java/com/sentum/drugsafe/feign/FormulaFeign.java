package com.sentum.drugsafe.feign;


import com.alibaba.fastjson.JSONObject;
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;


/**
 * @author sunlei
 */
@Component
@FeignClient(name = "sentum-evimed-formula")
public interface FormulaFeign {

    /**
     * 检索中台
     * @param data query-检索式；type-1文献，2指南，3说明书，4临床试验
     * @return 拼接后的检索条件
     */
    @PostMapping("/formula-api/retrieval")
    String retrieval(@RequestBody JSONObject data);
}
