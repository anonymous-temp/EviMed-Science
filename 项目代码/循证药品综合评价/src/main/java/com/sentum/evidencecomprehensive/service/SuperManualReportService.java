package com.sentum.evidencecomprehensive.service;

import com.alibaba.fastjson.JSONObject;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

/**
 * 超说明书报告相关api
 * @author zgm
 */
public interface SuperManualReportService {
    /**
     * 生成超说明书报告
     * @param id 检索id
     * @param userId 用户id
     * @return 生成的报告数据
     */
    JSONObject create(String id, Long userId, HttpServletRequest request);

    /**
     * 查询已经生成的报告
     * @param id 检索id
     * @return 报告数据
     */
    JSONObject show(String id);

    /**
     * 超说明书报告下载
     * @param id 检索id
     */
    void download(String id, HttpServletResponse response);
}
