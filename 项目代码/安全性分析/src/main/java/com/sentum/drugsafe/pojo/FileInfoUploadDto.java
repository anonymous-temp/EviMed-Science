package com.sentum.drugsafe.pojo;

import io.swagger.annotations.ApiModel;
import io.swagger.annotations.ApiModelProperty;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.springframework.web.multipart.MultipartFile;

/**
 * 上传pdf或word的Dto类
 * @author zgm
 */
@Data
@AllArgsConstructor
@NoArgsConstructor
@ApiModel("上传报告的请求类")
public class FileInfoUploadDto {
    @ApiModelProperty("文件名称")
    private String fileName;
    @ApiModelProperty("用户id")
    private String userId;
    @ApiModelProperty("用户名称")
    private String author;
    @ApiModelProperty("发布单位")
    private String workUnit;
    @ApiModelProperty("发布科室")
    private String department;
    @ApiModelProperty("简介")
    private String profile;
    @ApiModelProperty("用户上传的文件")
    private MultipartFile file;
    @ApiModelProperty("药品名称")
    private String drugName;
    @ApiModelProperty("不良反应名称")
    private String ptName;
}
