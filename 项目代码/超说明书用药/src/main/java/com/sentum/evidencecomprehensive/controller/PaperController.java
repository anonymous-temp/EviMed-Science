package com.sentum.evidencecomprehensive.controller;

import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.constants.Constants;
import com.sentum.evidencecomprehensive.pojo.dto.PaperExportDto;
import com.sentum.evidencecomprehensive.pojo.dto.PaperOperateDto;
import com.sentum.evidencecomprehensive.pojo.dto.PaperSearchDto;
import com.sentum.evidencecomprehensive.pojo.vo.DataResult;
import com.sentum.evidencecomprehensive.pojo.vo.ExcludeReasonVo;
import com.sentum.evidencecomprehensive.pojo.vo.req.PaperInfoEditRequest;
import com.sentum.evidencecomprehensive.pojo.vo.req.PaperStandardRequest;
import com.sentum.evidencecomprehensive.pojo.vo.req.PaperUploadRequest;
import com.sentum.evidencecomprehensive.pojo.vo.req.PdfRequestRequest;
import com.sentum.evidencecomprehensive.service.PaperService;
import com.sentum.evidencecomprehensive.utils.RedisUtil;
import io.swagger.annotations.Api;
import io.swagger.annotations.ApiImplicitParam;
import io.swagger.annotations.ApiImplicitParams;
import io.swagger.annotations.ApiOperation;
import lombok.Getter;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.*;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.util.Map;

@Slf4j
@Api(tags = "文献页面相关API")
@RestController
@RequestMapping("/evidence-api/paper-api")
public class PaperController {
    
    @Autowired
    private PaperService paperService;
    
    @GetMapping("/trans/paper")
    public DataResult transPaper(String id) {
        Map<String, Object> transPaperInfo =  paperService.transPaper(id);
        return DataResult.data(transPaperInfo);
    }

    @PostMapping("/save/paperStandard")
    @ApiOperation(value = "保存每个文献的质量评价标准", notes = "save-paperStandard")
    public DataResult savePaperStandard(@RequestBody PaperStandardRequest paperStandardRequest) {
        Boolean aBoolean = paperService.savePaperStandard(paperStandardRequest);
        return DataResult.ok();
    }

    @GetMapping("/get/alg/initial")
    @ApiOperation(value = "算法解析 pdf 后的每个模块的初始数据", notes = "get-alg-initial")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "paperId", value = "文献 id", required = true),
            @ApiImplicitParam(name = "questionId", value = "课题 id", required = true),
            @ApiImplicitParam(name = "studyType", value = "文献类型", required = true)
    })
    public DataResult getAlgInitial(String paperId, String questionId, String studyType, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            userId = getUserIdFromToken(request);
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        return DataResult.ok(paperService.getAlgInitial(paperId, questionId, userId, studyType));
    }

    @PostMapping("/get/pdf")
    @ApiOperation(value = "pdf 预览", notes = "get-pdf")
    public DataResult getPdf(@RequestBody PdfRequestRequest pdfRequestDo, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            userId = getUserIdFromToken(request);
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        return DataResult.data(paperService.getPdf(pdfRequestDo, userId));
    }

    @GetMapping("/get/info/initial")
    @ApiOperation(value = "信息提取初始数据", notes = "get-info-initial")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "paperId", value = "文献 id", required = true),
            @ApiImplicitParam(name = "questionId", value = " 课题 id", required = true),
            @ApiImplicitParam(name = "studyType", value = "文献类型", required = true)
    })
    public DataResult getInfoInitial(String paperId, String questionId, String studyType) {
        return DataResult.ok(paperService.getInfoInitial(paperId, questionId, studyType));
    }

    @PostMapping("/save/paperInfo")
    @ApiOperation(value = "保存信息提取数据", notes = "save-paperInfo")
    public DataResult savePaperInfo(@RequestBody PaperInfoEditRequest paperInfoEditRequest) {
        Boolean aBoolean = paperService.savePaperInfo(paperInfoEditRequest);
        return DataResult.ok();
    }

    @ApiOperation(value = "上传文献pdf", notes = "upload-pdf")
    @PostMapping("/upload/pdf")
    public DataResult uploadPdf(PaperUploadRequest paperUploadRequest, HttpServletRequest request, HttpServletResponse response) {
        // 1. 验证token并获取用户ID
        long userId;
        try {
            userId = getUserIdFromToken(request);
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }

        // 2. 调用服务层上传PDF
        int uploadResult = paperService.uploadPdf(paperUploadRequest, userId);

        // 3. 根据结果返回相应响应
        return buildResponse(uploadResult);
    }

    /**
     * 根据上传结果构建响应
     */
    private DataResult buildResponse(int uploadResult) {
        switch (uploadResult) {
            case 0:
                return DataResult.ok();
            case 1:
                return DataResult.error("上传失败");
            case 2:
                return DataResult.error(400, "有人正在操作，请等待！");
            default:
                return DataResult.error("上传失败");
        }
    }

    @ApiOperation(value = "获取文献左边栏列表文献分类数量列表", notes = "type-num-list")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "id", value = "检索id", required = true),
            @ApiImplicitParam(name = "type", value = "0默认，1纳入，2排除", required = true)
    })
    @GetMapping("/type-num-list")
    public DataResult typeNumList(String id, @RequestParam(defaultValue = "0") String type, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            userId = getUserIdFromToken(request);
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        return DataResult.data(paperService.typeNumList(id, type, userId));
    }

    @ApiOperation(value = "检索文献列表", notes = "list")
    @PostMapping("/list")
    public DataResult list(@RequestBody PaperSearchDto paperSearchDto, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            userId = getUserIdFromToken(request);
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        return DataResult.data(paperService.list(paperSearchDto, userId));
    }

    @ApiOperation(value = "操作/批量操作（收藏/取消收藏；纳入/取消纳入；排除/取消排除）", notes = "operate")
    @PostMapping("/operate")
    public DataResult operate(@RequestBody PaperOperateDto paperOperateDto, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            userId = getUserIdFromToken(request);
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        return DataResult.data(paperService.operate(paperOperateDto, userId));
    }

    @ApiOperation(value = "修改文献的质量等级", notes = "update-quality")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "id", value = "检索id", required = true),
            @ApiImplicitParam(name = "paperId", value = "文献id", required = true),
            @ApiImplicitParam(name = "quality", value = "修改后的文献质量等级", required = true)
    })
    @GetMapping("/update-quality")
    public DataResult updateQuality(String id, String paperId, Integer quality, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            userId = getUserIdFromToken(request);
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        return DataResult.data(paperService.updateQuality(id, paperId, quality, userId));
    }

    @ApiOperation(value = "批量/单个题录导出", notes = "export")
    @PostMapping("/export")
    public void export(@RequestBody PaperExportDto paperExportDto, HttpServletResponse response){
        paperService.export(paperExportDto, response);
    }

    @ApiOperation(value = "展示用户收藏的文献列表数据", notes = "show-paper-collect")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "searchWord", value = "用户检索词"),
            @ApiImplicitParam(name = "pageSize", value = "每页大小", required = true),
            @ApiImplicitParam(name = "pageNum", value = "当前页", required = true)
    })
    @GetMapping("/show-paper-collect")
    public DataResult showPaperCollect(HttpServletRequest request, HttpServletResponse response, String searchWord, @RequestParam(defaultValue = "1") Integer pageSize, @RequestParam(defaultValue = "10")  Integer pageNum) {
        long userId;
        try {
            userId = getUserIdFromToken(request);
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        return DataResult.data(paperService.showPaperCollect(userId, searchWord, pageSize, pageNum));
    }

    @PostMapping("/exclude-reason")
    @ApiOperation(value = "添加文献排除理由", notes = "reason")
    public DataResult excludeReason(@RequestBody ExcludeReasonVo excludeReasonVo, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            userId = getUserIdFromToken(request);
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        paperService.excludeReason(excludeReasonVo, userId);
        return DataResult.ok();
    }

    /**
     * 从请求中提取用户ID
     */
    private long getUserIdFromToken(HttpServletRequest request) {
        String token = request.getHeader("token");
        if (token == null || token.trim().isEmpty()) {
            throw new IllegalArgumentException("Token is null or empty");
        }

        Object redis = RedisUtil.redis.opsForValue().get("access_token_" + token);
        if (redis == null) {
            throw new IllegalArgumentException("Invalid token");
        }

        JSONObject redisMap = JSONObject.parseObject(redis.toString());
        return Long.parseLong(redisMap.get("userId").toString());
    }
}
