package com.sentum.evidencecomprehensive.controller;

import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.constants.Constants;
import com.sentum.evidencecomprehensive.domain.vo.DataResult;
import com.sentum.evidencecomprehensive.domain.vo.ExcludeReasonVo;
import com.sentum.evidencecomprehensive.domain.vo.evaluate.PaperInfoEditVo;
import com.sentum.evidencecomprehensive.domain.vo.evaluate.PaperStandardVo;
import com.sentum.evidencecomprehensive.domain.vo.req.*;
import com.sentum.evidencecomprehensive.service.PaperService;
import com.sentum.evidencecomprehensive.utils.RedisUtil;
import io.swagger.annotations.Api;
import io.swagger.annotations.ApiImplicitParam;
import io.swagger.annotations.ApiImplicitParams;
import io.swagger.annotations.ApiOperation;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.*;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import javax.validation.Valid;

@Slf4j
@Api(tags = "文献页面相关API")
@RestController
@RequestMapping("/evidence-api-based/paper-api")
public class PaperController {
    @Autowired
    private PaperService paperService;
    
    @ApiOperation(value = "获取文献左边栏列表文献分类数量列表", notes = "type-num-list")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "id", value = "检索id", required = true),
            @ApiImplicitParam(name = "type", value = "0默认，1纳入，2排除", required = true)
    })
    @PostMapping("/type-num-list")
    public DataResult typeNumList(@Valid @RequestBody PaperInitialRequest paperInitialRequest, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get(Constants.ACCESS_TOKEN + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = redisMap.getLong("userId");
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        return DataResult.data(paperService.typeNumList(paperInitialRequest, userId));
    }

    @ApiOperation(value = "检索文献列表", notes = "list")
    @PostMapping("/list")
    public DataResult list(@Valid @RequestBody PaperSearchRequest paperSearchRequest, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get(Constants.ACCESS_TOKEN + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = redisMap.getLong("userId");
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        return DataResult.data(paperService.list(paperSearchRequest, userId));
    }

    @ApiOperation(value = "操作/批量操作（收藏/取消收藏；纳入/取消纳入；排除/取消排除）", notes = "operate")
    @PostMapping("/operate")
    public DataResult operate(@RequestBody OperateRequest OperateRequest, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get(Constants.ACCESS_TOKEN + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = redisMap.getLong("userId");
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        return DataResult.data(paperService.operate(OperateRequest, userId));
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
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get(Constants.ACCESS_TOKEN + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = redisMap.getLong("userId");
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        return DataResult.data(paperService.updateQuality(id, paperId, quality, userId));
    }


    @ApiOperation(value = "批量/单个题录导出", notes = "export")
    @PostMapping("/export")
    public void export(@RequestBody PaperExportRequest paperExportRequest, HttpServletResponse response){
        paperService.export(paperExportRequest, response);
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
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get(Constants.ACCESS_TOKEN + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = redisMap.getLong("userId");
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        return DataResult.data(paperService.showPaperCollect(userId, searchWord, pageSize, pageNum));
    }

    @ApiOperation(value = "参考价格", notes = "show-reference-price")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "id", value = "检索id", required = true),
            @ApiImplicitParam(name = "search", value = "检索框检索条件", required = true)
    })
    @GetMapping("/show-reference-price")
    public DataResult showReferencePrice(String id, String search) {
        return DataResult.data(paperService.showReferencePrice(id, search));
    }

    @PostMapping("/exclude-reason")
    @ApiOperation(value = "添加文献排除理由", notes = "reason")
    public DataResult excludeReason(@RequestBody ExcludeReasonVo excludeReasonVo, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get(Constants.ACCESS_TOKEN + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = redisMap.getLong("userId");
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        return DataResult.ok(paperService.excludeReason(excludeReasonVo, userId));
    }






    // #######################################质量评价相关#############################################3
    @ApiOperation(value = "上传文献pdf", notes = "upload-pdf")
    @PostMapping("/upload-pdf")
    public DataResult uploadPdf(PaperUploadRequest paperUploadRequest, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get(Constants.ACCESS_TOKEN + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = redisMap.getLong("userId");
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        // 0 成功  1 失败  
        int uploadSuccess = paperService.uploadPdf(paperUploadRequest, userId);
        if (uploadSuccess == 0) {
            return DataResult.ok();
        } else if (uploadSuccess == 1){
            return DataResult.error("上传失败");
        } else if (uploadSuccess == 2) {
            DataResult dataResult = new DataResult();
            dataResult.put("code", 400);
            dataResult.put("msg", "有人正在操作，请等待！");
            return dataResult;
        } else {
            return DataResult.error("上传失败");
        }
    }
    
    @PostMapping("/get/pdf")
    @ApiOperation(value = "pdf 预览", notes = "get-pdf")
    public DataResult getPdf(@RequestBody PdfRequestRequest pdfRequestDo, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get(Constants.ACCESS_TOKEN + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = redisMap.getLong("userId");
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
    public DataResult savePaperInfo(@RequestBody PaperInfoEditVo paperInfoEditVo) {
        Boolean aBoolean = paperService.savePaperInfo(paperInfoEditVo);
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
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get(Constants.ACCESS_TOKEN + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = redisMap.getLong("userId");
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        return DataResult.ok(paperService.getAlgInitial(paperId, questionId, userId, studyType));
    }

    @PostMapping("/save/paperStandard")
    @ApiOperation(value = "保存每个文献的质量评价标准", notes = "save-paperStandard")
    public DataResult savePaperStandard(@RequestBody PaperStandardVo paperStandardVo) {
        Boolean aBoolean = paperService.savePaperStandard(paperStandardVo);
        return DataResult.ok();
    }

    @PostMapping("/get/alg/pdf")
    @ApiOperation(value = "算法解析的 pdf 预览", notes = "get-alg-pdf")
    public DataResult getAlgPdf(@RequestBody PdfRequestRequest pdfRequestDo, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get(Constants.ACCESS_TOKEN + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = redisMap.getLong("userId");
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        return DataResult.data(paperService.getAlgPdf(pdfRequestDo, userId));
    }
























}
