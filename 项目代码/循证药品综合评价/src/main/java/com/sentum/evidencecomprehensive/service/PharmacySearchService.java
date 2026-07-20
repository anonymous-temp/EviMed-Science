package com.sentum.evidencecomprehensive.service;

import com.sentum.evidencecomprehensive.domain.mongo.GuideIncludeOrExclude;
import com.sentum.evidencecomprehensive.domain.mongo.HtaIncludeOrExclude;
import com.sentum.evidencecomprehensive.domain.mongo.HtaReport;
import com.sentum.evidencecomprehensive.domain.mongo.PaperIncludeOrExclude;
import com.sentum.evidencecomprehensive.domain.vo.req.HtaReportSearchRequest;

import java.util.List;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/4/1
 */
public interface PharmacySearchService {
    
    List<HtaReport> searchHtaReport(HtaReportSearchRequest htaReportSearchRequest);

    List<PaperIncludeOrExclude> searchPaperInclude(String id, Integer status, Integer includeType, Integer type);

    List<GuideIncludeOrExclude> searchGuideInclude(String id, int status);

    List<HtaIncludeOrExclude> searchHtaInclude(String id, int status);
}
