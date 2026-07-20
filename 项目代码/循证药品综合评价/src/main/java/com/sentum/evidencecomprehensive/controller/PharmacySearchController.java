package com.sentum.evidencecomprehensive.controller;

import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.domain.mongo.GuideIncludeOrExclude;
import com.sentum.evidencecomprehensive.domain.mongo.HtaIncludeOrExclude;
import com.sentum.evidencecomprehensive.domain.mongo.HtaReport;
import com.sentum.evidencecomprehensive.domain.mongo.PaperIncludeOrExclude;
import com.sentum.evidencecomprehensive.domain.vo.req.HtaReportSearchRequest;
import com.sentum.evidencecomprehensive.domain.vo.req.PaperIncludeSearchRequest;
import com.sentum.evidencecomprehensive.service.PharmacySearchService;
import io.swagger.annotations.Api;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.*;

import java.util.List;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/4/1
 */
@Slf4j
@Api(tags = "供pharmacy相关API")
@RestController
@RequestMapping("/evidence-api-based/pharmacy-api")
public class PharmacySearchController {
    
    @Autowired
    private PharmacySearchService pharmacySearchService;

    @GetMapping("search-htaInclude")
    public List<HtaIncludeOrExclude> searchHtaInclude(String id, int status) {
        return pharmacySearchService.searchHtaInclude(id, status);
    }
    
    @PostMapping("search-htaReport")
    public List<HtaReport> searchHtaReport(@RequestBody HtaReportSearchRequest htaReportSearchRequest) {
        return pharmacySearchService.searchHtaReport(htaReportSearchRequest);
    }
    
    @GetMapping("search-paperInclude")
    public List<PaperIncludeOrExclude> searchPaperInclude(String id, Integer status, Integer includeType, Integer type) {
        return pharmacySearchService.searchPaperInclude(id, status, includeType, type);
    }

    @GetMapping("search-guideInclude")
    public List<GuideIncludeOrExclude> searchGuideInclude(String id, int status) {
        return pharmacySearchService.searchGuideInclude(id, status);
    }
}
