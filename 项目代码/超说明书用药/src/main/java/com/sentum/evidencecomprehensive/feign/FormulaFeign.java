package com.sentum.evidencecomprehensive.feign;

import com.alibaba.fastjson.JSONObject;
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;

/**
 * Description: 检索中台
 */
@Component
@FeignClient(name = "sentum-evimed-formula")
public interface FormulaFeign {
    
    /**
     * 检索中台
     * @param data query-检索式；type-1文献，2指南，3说明书，4临床试验，5hta
     * @return 拼接后的检索条件
     */
    @PostMapping("/formula-api/retrieval")
    String formula(@RequestBody JSONObject data);
}