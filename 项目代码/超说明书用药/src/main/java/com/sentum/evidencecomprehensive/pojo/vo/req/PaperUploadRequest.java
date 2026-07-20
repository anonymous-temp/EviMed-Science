package com.sentum.evidencecomprehensive.pojo.vo.req;

import io.swagger.annotations.ApiModelProperty;
import lombok.*;
import org.springframework.web.multipart.MultipartFile;

@Setter
@Getter
public class PaperUploadRequest {

    @ApiModelProperty("文献 id")
    private String id;

    @ApiModelProperty("课题 id")
    private String questionId;

    @ApiModelProperty("文献类型")
    private String type;

    @ApiModelProperty("上传的文献pdf")
    private MultipartFile file;
}
