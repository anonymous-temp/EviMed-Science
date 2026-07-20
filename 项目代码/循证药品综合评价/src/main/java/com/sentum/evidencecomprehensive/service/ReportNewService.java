package com.sentum.evidencecomprehensive.service;

import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.domain.vo.PageVo;
import com.sentum.evidencecomprehensive.domain.vo.req.EditMultiContentRequest;
import com.sentum.evidencecomprehensive.domain.vo.req.GenTemplateRequest;
import com.sentum.evidencecomprehensive.domain.vo.req.SaveContentRequest;
import com.sentum.evidencecomprehensive.domain.vo.req.SaveTemplateRequest;
import com.sentum.evidencecomprehensive.domain.vo.resp.ClickReportResponse;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.util.List;

/**
 * Author: <a href="https://gitee.com/yyyyouhfqaq">bcxsg</a>
 * Description:
 * DateTime: 2025/3/10
 */
public interface ReportNewService {
    
    List<String> createReportTemplate(String id, String verifyToken, long userId, HttpServletRequest request);

    void saveTemplate(SaveTemplateRequest saveTemplateRequest);
    
    void fillTemplate(GenTemplateRequest genTemplateRequest, long userId, String token, HttpServletResponse response);

    void saveContent(SaveContentRequest saveContentRequest);

    List<JSONObject> searchReportRight(String id);

    void executeMode(String id, String clickMode, long userId, String token);

    PageVo<ClickReportResponse> searchClickStatus(long userId, Integer pageSize, Integer pageNum);

    void deleteClickReport(long userId, String id, String allD);

    String updateClickStatus(long userId, String id);

    void downloadWord(String id, String source, HttpServletResponse response);

    void editMultiContent(EditMultiContentRequest editMultiContentRequest, long userId, String token, HttpServletResponse response);

    void createReportTemplateApp(String id, String verifyToken, String token, long userId, HttpServletRequest request);
    
}
