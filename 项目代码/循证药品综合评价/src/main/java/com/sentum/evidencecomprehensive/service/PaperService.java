package com.sentum.evidencecomprehensive.service;

import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.domain.mongo.Condition;
import com.sentum.evidencecomprehensive.domain.vo.ExcludeReasonVo;
import com.sentum.evidencecomprehensive.domain.vo.PageVo;
import com.sentum.evidencecomprehensive.domain.vo.req.*;
import com.sentum.evidencecomprehensive.domain.vo.resp.PaperResponse;
import com.sentum.evidencecomprehensive.domain.vo.ReferencePriceVo;
import com.sentum.evidencecomprehensive.domain.vo.evaluate.PaperInfoEditVo;
import com.sentum.evidencecomprehensive.domain.vo.evaluate.PaperStandardVo;
import org.elasticsearch.index.query.BoolQueryBuilder;

import javax.servlet.http.HttpServletResponse;
import javax.validation.Valid;
import java.util.Map;

/**
 * 文献页面相关逻辑
 * @author zgm
 */
public interface PaperService {
    /**
     * 获取各个文献分类的数量
     *
     * @param paperInitialRequest
     * @param userId
     * @return 分类数量列表
     */
    JSONObject typeNumList(PaperInitialRequest paperInitialRequest, long userId);

    /**
     * 检索文献列表
     * @param paperSearchRequest 检索条件
     * @param userId 用户id
     * @return 当前页的文献列表
     */
    PageVo<PaperResponse> list(PaperSearchRequest paperSearchRequest, Long userId);

    /**
     * 操作/批量操作（收藏/取消收藏；纳入/取消纳入；排除/取消排除）
     * @param OperateRequest 操作实体
     * @param userId 用户id
     * @return 成功true
     */
    Boolean operate(OperateRequest OperateRequest, Long userId);

    /**
     * 修改文献质量等级
     * @param id 检索id
     * @param paperId 文献id
     * @param quality 修改后的文献质量
     * @param userId 用户id
     * @return 成功true
     */
    Boolean updateQuality(String id, String paperId, Integer quality, Long userId);

    /**
     * 用户上传文献pdf
     * @param paperUploadRequest 上传实体
     * @param userId 用户id
     * @return 成功true
     */
    int uploadPdf(PaperUploadRequest paperUploadRequest, Long userId);

    /**
     * 批量/单个导出文献题录
     * @param paperExportRequest 请求题录的实体
     * @param response 返回体
     */
    void export(PaperExportRequest paperExportRequest, HttpServletResponse response);

    /**
     * 展示用户收藏的文献列表数据
     * @param userId 用户id
     * @param searchWord 用户检索词
     * @param pageSize 每页大小
     * @param pageNum 当前页
     * @return 药品列表
     */
    PageVo<PaperResponse> showPaperCollect(Long userId, String searchWord, Integer pageSize, Integer pageNum);

    /**
     * 预览pdf
     *
     * @param pdfRequestDo 请求实体类
     * @param userId
     */
    PageVo<String> getPdf(PdfRequestRequest pdfRequestDo, long userId);

    /**
     * 待评价药品和对照药品 - 参考价格查询
     * @param id 课题id
     * @param search 检索框检索条件
     */
    ReferencePriceVo showReferencePrice(String id, String search);

    /**
     * 添加文献排除理由
     */
    String excludeReason(ExcludeReasonVo excludeReasonVo, long userId);
    
    /**
     * 信息提取初始数据
     */
    Map<String, Object> getInfoInitial(String paperId, String questionId, String studyType);

    /**
     * 信息提取修改
     */
    Boolean savePaperInfo(PaperInfoEditVo paperInfoEditVo);

    /**
     * 质量评价分析结果
     *
     * @param paperId    文献 id
     * @param questionId 课题 id
     * @param userId
     * @param studyType  当前分析文献类型
     */
    Map<String, Object> getAlgInitial(String paperId, String questionId, long userId, String studyType);

    /**
     * 质量评价标准修改
     */
    Boolean savePaperStandard(PaperStandardVo paperStandardVo);

    /**
     * 获取算法解析之后的pdf的图片预览
     *
     * @param pdfRequestDo 请求实体类
     * @param userId
     */
    PageVo<String> getAlgPdf(PdfRequestRequest pdfRequestDo, long userId);

    /**
     * 用于高级检索
     *
     */
    BoolQueryBuilder useMode(String mode, String zhEnExtension, String synonymExtension);
}

