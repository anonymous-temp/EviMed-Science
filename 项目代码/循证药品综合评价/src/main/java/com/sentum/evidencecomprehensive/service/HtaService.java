package com.sentum.evidencecomprehensive.service;

import com.sentum.evidencecomprehensive.domain.vo.req.HTASearchRequest;
import com.sentum.evidencecomprehensive.domain.mongo.HtaReport;
import com.sentum.evidencecomprehensive.domain.vo.req.OperateRequest;
import com.sentum.evidencecomprehensive.domain.vo.HtaInitialVo;
import com.sentum.evidencecomprehensive.domain.vo.PageVo;
import com.sentum.evidencecomprehensive.domain.vo.resp.HtaReportResponse;

/**
 * Description: hta报告 业务接口类
 */
public interface HtaService {
    /**
     * hta 搜索栏 数据获取
     */
    HtaInitialVo getInitialData(String id, long userId);
    
    /**
     * 获取hta报告列表
     */
    PageVo<HtaReportResponse> list(HTASearchRequest htaSearchRequest, long userId);
    
    /**
     * 获取hta报告收藏
     */
    PageVo<HtaReport> getCollect(HTASearchRequest htaSearchRequest, long userId);

    /**
     * 根据hta报告id 获取报告的base64
     */
    String getPdfBase64(String id);

    /**
     * hta默认纳入逻辑
     * @param id 检索id
     * @param userId 用户id
     * @return 成功true
     */
    Boolean defaultInclusion(String id, Long userId);

    /**
     * 操作/批量操作（收藏/取消收藏；纳入/取消纳入；排除/取消排除）
     * @param OperateRequest 操作实体
     * @param userId 用户id
     * @return 成功true
     */
    Boolean operate(OperateRequest OperateRequest, Long userId);
}
