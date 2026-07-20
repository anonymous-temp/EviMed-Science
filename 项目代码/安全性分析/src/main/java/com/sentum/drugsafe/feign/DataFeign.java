package com.sentum.drugsafe.feign;

import com.sentum.drugsafe.dto.SafeInfoDto;
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;

@FeignClient("SENTUM-EVIMED-EVIDENCE-COMPREHENSIVE-LI")
public interface DataFeign {
    /**
     * 查询适应症
     * @param drugSafeDto 检索条件
     * @return 适应症信息
     */
    @PostMapping("/evidence-api/adverse-api/indication")
    String getIndication(@RequestBody SafeInfoDto drugSafeDto);

    @PostMapping("/evidence-api/adverse-api/indication-jd")
    String getIndicationJd(@RequestBody SafeInfoDto drugSafeDto);
    /**
     * 查询pdf数据
     * @param drugSafeDto 检索条件
     * @return fda数据分析
     */
    @PostMapping("/evidence-api/adverse-api/drug-safe-info")
    String getData(@RequestBody SafeInfoDto drugSafeDto) ;

    @PostMapping("/evidence-api/adverse-api/drug-safe-info-jd")
    String getDataJd(@RequestBody SafeInfoDto drugSafeDto) ;
}
