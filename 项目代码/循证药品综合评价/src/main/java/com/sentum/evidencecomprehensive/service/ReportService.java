package com.sentum.evidencecomprehensive.service;

import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.domain.vo.DataResult;
import com.sentum.evidencecomprehensive.domain.vo.InitialRequestVo;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

/**
 * 报告页面相关逻辑
 * @author zgm
 */
public interface ReportService {
    /**
     * 首页弹框
     * @param initialRequestVo ---
     * @param userId 用户id
     */
    DataResult getInitialData(InitialRequestVo initialRequestVo, long userId);

    /**
     * 生成决策报告
     *
     * @param id          课题id
     * @param update      更新课题
     * @param userId      用户id
     * @param source
     * @param verifyToken
     */
    DataResult createEvidenceBasedReport(String id, boolean update, Long userId, String type, String source, String verifyToken, HttpServletRequest request);

    /**
     * 查看报告
     * @param id 检索id
     * @return 报告数据
     */
    JSONObject show(String id);

    /**
     * 默认纳入
     *
     * @param id     课题 id
     * @param userId 用户 id
     * @param data
     */
    void include(String id, long userId, JSONObject data);

    String createToken(String id, long userId, HttpServletRequest request);
}
