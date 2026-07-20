package com.sentum.evidencecomprehensive.service;

import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.pojo.bo.mongo.Condition;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

/**
 * 超说明书报告相关api
 * @author zgm
 */
public interface SuperManualReportService {
    /**
     * 查询已经生成的报告
     * @param id 检索id
     * @return 报告数据
     */
    JSONObject show(String id);

    /**
     * 缓存修改后的报告数据
     * @param dataJson 修改后的报告数据
     * @return 成功true
     */
    boolean changeCache(JSONObject dataJson);

    /**
     * 默认纳入
     *
     * @param id     课题 id
     * @param userId 用户 id
     */
    void include(String id, long userId, JSONObject data);


    /**
     * 生成超说明书报告 pc 端使用
     *
     * @param id          检索id
     * @param userId      用户id
     * @return 生成的报告数据
     */
    JSONObject createPc(String id, Long userId, String type, String source, String verifyToken, HttpServletRequest request);

    /**
     * 查询已经生成的报告 pc 端使用
     * @param id 检索id
     * @return 报告数据
     */
    JSONObject showPc(String id);
    
    /**
     * 超说明书报告下载 pc 端使用
     */
    void downloadPc(String id, String source, HttpServletResponse response, String channel);

    String createToken(String id, long userId, HttpServletRequest request);
}
