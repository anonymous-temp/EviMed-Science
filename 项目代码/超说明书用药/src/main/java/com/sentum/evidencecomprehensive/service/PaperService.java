package com.sentum.evidencecomprehensive.service;

import com.alibaba.fastjson.JSONArray;
import com.sentum.evidencecomprehensive.pojo.dto.PaperExportDto;
import com.sentum.evidencecomprehensive.pojo.dto.PaperOperateDto;
import com.sentum.evidencecomprehensive.pojo.dto.PaperSearchDto;
import com.sentum.evidencecomprehensive.pojo.vo.ExcludeReasonVo;
import com.sentum.evidencecomprehensive.pojo.vo.PageVo;
import com.sentum.evidencecomprehensive.pojo.vo.PaperVo;
import com.sentum.evidencecomprehensive.pojo.vo.req.PaperInfoEditRequest;
import com.sentum.evidencecomprehensive.pojo.vo.req.PaperStandardRequest;
import com.sentum.evidencecomprehensive.pojo.vo.req.PaperUploadRequest;
import com.sentum.evidencecomprehensive.pojo.vo.req.PdfRequestRequest;
import org.elasticsearch.index.query.BoolQueryBuilder;

import javax.servlet.http.HttpServletResponse;
import java.util.Map;

/**
 * 文献页面相关逻辑
 * @author zgm
 */
public interface PaperService {
    /**
     * 获取各个文献分类的数量
     * @param id 检索id
     * @return 分类数量列表
     */
    JSONArray typeNumList(String id, String type, long userId);

    /**
     * 检索文献列表
     * @param paperSearchDto 检索条件
     * @param userId 用户id
     * @return 当前页的文献列表
     */
    PageVo<PaperVo> list(PaperSearchDto paperSearchDto, Long userId);

    /**
     * 操作/批量操作（收藏/取消收藏；纳入/取消纳入；排除/取消排除）
     * @param paperOperateDto 操作实体
     * @param userId 用户id
     * @return 成功true
     */
    Boolean operate(PaperOperateDto paperOperateDto, Long userId);

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
     *
     * @param paperUploadRequest 上传实体
     * @param userId             用户id
     * @return 成功true
     */
    Integer uploadPdf(PaperUploadRequest paperUploadRequest, long userId);

    /**
     * 批量/单个导出文献题录
     * @param paperExportDto 请求题录的实体
     * @param response 返回体
     */
    void export(PaperExportDto paperExportDto, HttpServletResponse response);

    /**
     * 展示用户收藏的文献列表数据
     * @param userId 用户id
     * @param searchWord 用户检索词
     * @param pageSize 每页大小
     * @param pageNum 当前页
     * @return 药品列表
     */
    PageVo<PaperVo> showPaperCollect(Long userId, String searchWord, Integer pageSize, Integer pageNum);
    
    /**
     * 用户进行文献排除添加的理由
     */
    void excludeReason(ExcludeReasonVo excludeReasonVo, long userId);

    /**
     * 用于高级检索
     *
     */
    BoolQueryBuilder useMode(String mode, String zhEnExtension, String synonymExtension);

    void includeLatest(String id, Long userId);

    Map<String, Object> getInfoInitial(String paperId, String questionId, String studyType);

    PageVo<String> getPdf(PdfRequestRequest pdfRequestDo, long userId);

    Boolean savePaperInfo(PaperInfoEditRequest paperInfoEditRequest);

    Map<String, Object> getAlgInitial(String paperId, String questionId, long userId, String studyType);

    Boolean savePaperStandard(PaperStandardRequest paperStandardRequest);

    Map<String, Object> transPaper(String id);
}
