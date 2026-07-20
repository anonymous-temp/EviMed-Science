package com.sentum.controller;

import com.alibaba.fastjson.JSONObject;
import com.sentum.pojo.dto.FileInfoUploadDto;
import com.sentum.pojo.vo.DataResult;
import com.sentum.service.ReleaseService;
import com.sentum.util.RedisUtil;
import io.swagger.annotations.Api;
import io.swagger.annotations.ApiImplicitParam;
import io.swagger.annotations.ApiImplicitParams;
import io.swagger.annotations.ApiOperation;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

@Slf4j
@Api(tags = "发布页面相关API")
@RestController
@RequestMapping("/evaluation-api")
public class ReleaseController {
    @Autowired
    private ReleaseService releaseService;

    @ApiOperation(value = "发布页分页数据", notes = "release-info")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "searchInfo", value = "用户输入框输入词用户未输入时为null"),
            @ApiImplicitParam(name = "pageNum", value = "当前页，从1开始", required = true),
            @ApiImplicitParam(name = "pageSize", value = "每页大小", required = true)
    })
    @GetMapping("/release-info")
    public DataResult releaseInfo(HttpServletRequest request, HttpServletResponse response, String searchInfo, @RequestParam(defaultValue = "1") Integer pageNum, @RequestParam(defaultValue = "10") Integer pageSize) {
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get("access_token_" + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            long userId = Long.parseLong(redisMap.get("userId").toString());
            return DataResult.data(releaseService.releaseInfo(searchInfo, pageNum, pageSize, userId));
        } catch (Exception e) {
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
    }

    @ApiOperation(value = "发布页面上传文件弹窗用户信息回显", notes = "echo-user-info")
    @GetMapping("/echo-user-info")
    public DataResult echoUserInfo(HttpServletRequest request, HttpServletResponse response){
        try {
            String token = request.getHeader("token");
            return DataResult.data(releaseService.echoUserInfo(token));
        } catch (Exception e) {
            e.printStackTrace();
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
    }

    @ApiOperation(value = "发布页面上传文件接口", notes = "upload")
    @PostMapping("/upload")
    public DataResult upload(FileInfoUploadDto fileInfoUploadDto){
        MultipartFile file = fileInfoUploadDto.getFile();
        String name = file.getOriginalFilename();
        if (!name.endsWith(".pdf")){
            return DataResult.error("文件格式不正确，请上传pdf格式文件");
        }
        Boolean upload = releaseService.upload(fileInfoUploadDto);
        if (upload){
            return DataResult.ok();
        }
        return DataResult.error("文件上传失败，请稍后重试！");
    }

    @ApiOperation(value = "收藏或取消收藏", notes = "collect")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "releaseId", value = "报告id", required = true),
            @ApiImplicitParam(name = "status", value = "true收藏、false取消收藏", required = true)
    })
    @GetMapping("/collect")
    public DataResult collect(HttpServletRequest request, HttpServletResponse response, String releaseId, Boolean status) {
        try {
            String token = request.getHeader("token");
            Object redis = RedisUtil.redis.opsForValue().get("access_token_" + token);
            assert redis != null;
            JSONObject redisMap = JSONObject.parseObject(redis.toString());
            long userId = Long.parseLong(redisMap.get("userId").toString());
            return DataResult.data(releaseService.collect(releaseId, userId, status));
        } catch (Exception e) {
            if (e.getMessage() != null && e.getMessage().contains("请勿重复操作！")){
                throw e;
            }
            response.setStatus(401);
            return DataResult.error(401, "token can't null or empty string");
        }
    }
}
