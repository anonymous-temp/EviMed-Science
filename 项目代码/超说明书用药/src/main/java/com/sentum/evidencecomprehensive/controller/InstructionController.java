package com.sentum.evidencecomprehensive.controller;

import com.alibaba.fastjson.JSONObject;
import com.sentum.evidencecomprehensive.pojo.vo.DataResult;
import com.sentum.evidencecomprehensive.service.InstructionService;
import com.sentum.evidencecomprehensive.utils.RedisUtil;
import io.swagger.annotations.Api;
import io.swagger.annotations.ApiImplicitParam;
import io.swagger.annotations.ApiImplicitParams;
import io.swagger.annotations.ApiOperation;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

@Slf4j
@Api(tags = "说明书页面相关API")
@RestController
@RequestMapping("/evidence-api/instruction-api")
public class InstructionController {
    @Autowired
    private InstructionService instructionService;

    @GetMapping("/instruction/html")
    public DataResult instructionHtml(@RequestParam("source") String source, @RequestParam("pdfName")String pdfName) {
        return DataResult.data(instructionService.instructionHtml(source, pdfName));
    }

    @ApiOperation(value = "检索说明书列表", notes = "list")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "id", value = "检索条件id", required = true)
    })
    @GetMapping("/init-new")
    public DataResult initInstructions(String id) {

        return DataResult.data(instructionService.initInstructions(id));
    }

    @ApiOperation(value = "改版说明书列表", notes = "list")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "id", value = "检索条件id", required = true),
            @ApiImplicitParam(name = "oneLevelTerm", value = "一级选项", required = false),
            @ApiImplicitParam(name = "twoLevelTerm", value = "二级选项", required = false),
            @ApiImplicitParam(name = "threeLevelTerm", value = "三级选项", required = false),
            @ApiImplicitParam(name = "pageSize", value = "页大小", required = false),
            @ApiImplicitParam(name = "pageNum", value = "页位置", required = false),
            @ApiImplicitParam(name = "search", value = "额外查询条件", required = false),
    })
    @GetMapping("/navigationList")
    public DataResult navigationList(String id, String oneLevelTerm, String twoLevelTerm, String threeLevelTerm, @RequestParam(defaultValue = "10") Integer pageSize, @RequestParam(defaultValue = "1") Integer pageNum, String search) {
        return DataResult.data(instructionService.navigationList(id, oneLevelTerm, twoLevelTerm, threeLevelTerm, pageSize, pageNum, search));
    }

    @ApiOperation(value = "获取说明书类别列表", notes = "type-list")
    @ApiImplicitParam(name = "id", value = "检索id", required = true)
    @GetMapping("/type-list")
    public DataResult typeList(String id) {
        return DataResult.data(instructionService.typeList(id));
    }

    @ApiOperation(value = "检索说明书列表", notes = "list")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "id", value = "检索条件id", required = true),
            @ApiImplicitParam(name = "type", value = "选中的说明书的分类", required = true),
            @ApiImplicitParam(name = "pageSize", value = "每页大小", required = true),
            @ApiImplicitParam(name = "pageNum", value = "当前页", required = true),
            @ApiImplicitParam(name = "search", value = "适应症筛选框输入内容")
    })
    @GetMapping("/list")
    public DataResult list(String id, String type, Integer pageSize, Integer pageNum, String search, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get("access_token_" + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = Long.parseLong(redisMap.get("userId").toString());
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        return DataResult.data(instructionService.list(id, type, pageSize, pageNum, search, userId));
    }

    @ApiOperation(value = "操作/批量操作（收藏/取消收藏；纳入/取消纳入；排除/取消排除）", notes = "list")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "id", value = "检索条件id", required = true),
            @ApiImplicitParam(name = "instructionId", value = "说明书id，说明书的pdfName", required = true),
            @ApiImplicitParam(name = "operate", value = "操作的命令，1-收藏入；2-取消收藏", required = true)
    })
    @GetMapping("/operate")
    public DataResult operate(String id, String instructionId, Integer operate, HttpServletRequest request, HttpServletResponse response) {
        long userId;
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get("access_token_" + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            userId = Long.parseLong(redisMap.get("userId").toString());
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
        return DataResult.data(instructionService.operate(id, instructionId, userId, operate));
    }
}
